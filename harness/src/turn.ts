// 세션 노드 한 차례: 노드 진입 기록 → 맥락 → 세션 한 차례 → 원장 지키기 → 훅 확인 → 차례 뒤 변경 검사 → 관문 → 노드 종료 기록
//
// 지휘 프로그램(4dd run)은 이 함수를 노드마다 부르고, 통과하면 커밋하고 다음 노드로 간다.

import type { Adapter, TurnResult } from "./adapters.ts";
import type { Config } from "./config.ts";
import { buildContext } from "./context.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_DIR, REVIEW_NOTE_HEAD, runGate, type GateOutcome } from "./gate.ts";
import { checkDiff } from "./guard.ts";
import { appendEvent, nextId, readEvents } from "./ledger.ts";
import { ledgerIntact, ledgerSnapshot } from "./lock.ts";
import { getNode, sessionScope, type Cause, type NodeDef, type NodeSet } from "./nodes.ts";
import { loadState, type State } from "./state.ts";
import type { LedgerEvent } from "./ledger.ts";

export interface SessionNodeOptions {
  root: string;
  config: Config;
  nodes: NodeSet;
  nodeId: string;
  /** Stage 2의 작업. Stage 0·1에서는 null (Stage 2에서 돌아온 경우에는 원래 작업) */
  task: string | null;
  /** 지금 기능 폴더 이름 (조각 2: writes의 {feature}, Stage 0·1 관문과 맥락) */
  feature?: string | null;
  adapter: Adapter;
  timeoutMs?: number;
}

/** 이어 쓸 작업 세션: 작업마다(task) 또는 기능의 스테이지마다(stage, 조각 2) */
export function pickSession(events: LedgerEvent[], nodes: NodeSet, node: NodeDef, task: string | null, feature: string | null, state: State): string | null {
  if (sessionScope(node) === "task") return task && state.task === task ? state.session : null;
  const hit = events
    .filter((e): e is Extract<LedgerEvent, { type: "node_end" }> => e.type === "node_end" && !!e.session)
    .filter((e) => e.task === task && (task !== null || e.feature === feature))
    .filter((e) => nodes.nodes[e.node]?.actor === "worker" && nodes.nodes[e.node]?.stage === node.stage)
    .at(-1);
  return hit?.session ?? null;
}

export interface SessionNodeOutcome {
  runId: string;
  passed: boolean;
  /** 기계가 정한 실패 원인 (env, test_flaky) */
  cause?: Cause;
  /** 하네스가 멈추고 사람을 불러야 하는 이유 (원장이 고쳐짐, 훅이 꺼짐, 세션 오류) */
  stop?: string;
  turn: TurnResult;
  gate?: GateOutcome;
  reverted: string[];
  summary: string;
}

export function runSessionNode(opts: SessionNodeOptions): SessionNodeOutcome {
  const { root, nodes, nodeId, task } = opts;
  const feature = opts.feature ?? null;
  const node = getNode(nodes, nodeId);
  if (node.actor !== "worker") throw new Error(`${nodeId}는 작업 세션 노드가 아닙니다 (${node.actor})`);
  const H = nodes.version;
  const timeoutMs = opts.timeoutMs ?? nodes.defaults.turn_timeout_min * 60_000;

  const { events } = readEvents(root);
  const { state } = loadState(root);
  const runId = nextId(events, "NR");
  const session = pickSession(events, nodes, node, task, feature, state);
  const featureField = feature ? { feature } : {};
  appendEvent(root, H, { type: "node_start", id: runId, node: nodeId, task, ...featureField, session });

  const ctx = buildContext({ root, nodes, nodeId, task, feature });
  const snap = ledgerSnapshot(root);
  const env = { FOURDD_ROOT: root, FOURDD_NODE: nodeId, FOURDD_NODE_RUN: runId, ...(feature ? { FOURDD_FEATURE: feature } : {}) };
  const turn = opts.adapter.runTurn({ root, prompt: ctx.prompt, sessionId: session, env, timeoutMs });

  const notes: string[] = [];
  let stop: string | undefined;
  let cause: Cause | undefined;

  // 1. 원장 지키기: 세션 동안 원장에는 훅 실행 기록만 덧붙어야 한다.
  const intact = ledgerIntact(root, snap);
  if (!intact.allowed) stop = `원장이 세션 동안 바뀌었습니다: ${intact.reason}`;

  // 2. 새 세션이면 세션 시작 훅이 원장에 남긴 줄이 있어야 한다. 없으면 훅이 꺼진 것이다.
  if (!stop && session === null && turn.ok) {
    const alive = readEvents(root).events.some((e) => e.type === "hook_run" && e.check === "session" && e.run === runId);
    if (!alive) stop = `훅이 돌지 않았습니다 (${opts.adapter.agent} 세션 시작 기록 없음). Codex라면 /hooks에서 4DD 훅을 신뢰해야 합니다`;
  }

  // 3. 세션 오류나 시간 초과는 실행 환경 문제로 본다.
  if (!turn.ok) {
    cause = "env";
    notes.push(`세션 차례가 실패했습니다: ${turn.error ?? "알 수 없는 오류"}`);
  }

  // 4. 차례 뒤 변경 검사: 이 노드에서 고칠 수 없는 곳은 되돌린다.
  const diff = checkDiff(root, nodeId, runId, true, nodes, feature);
  if (diff.violations.length) notes.push(diff.message);

  // 5. 관문
  let gate: GateOutcome | undefined;
  if (!stop && turn.ok && node.gate) {
    gate = runGate({ root, config: opts.config, nodes, nodeId, task, feature, runId });
    if (gate.cause) cause = gate.cause;
    notes.push(gate.summary);
  }

  // 6. 관문의 리뷰 세션 (조각 2: N13 설계, N14 작업 나누기). 기계 검사를 통과했을 때만 돈다.
  let review: GateReview | undefined;
  if (!stop && turn.ok && diff.violations.length === 0 && gate?.passed && node.gate?.review) {
    review = runGateReview({ ...opts, feature, runId, env, timeoutMs, gateSummary: gate.summary });
    if (review.stop) stop = review.stop;
    if (review.cause) cause = review.cause;
    notes.push(review.summary);
  }

  const passed = !stop && turn.ok && diff.violations.length === 0 && (gate?.passed ?? true) && (review?.passed ?? true);
  const both = review?.turn ? sumTurns(turn, review.turn) : turn;
  appendEvent(root, H, {
    type: "node_end",
    id: runId,
    node: nodeId,
    task,
    ...featureField,
    result: stop ? "wait" : passed ? "pass" : "fail",
    ...(cause && !passed ? { cause } : {}),
    ...(passed && gate?.alreadyMet ? { already_met: true } : {}),
    session: turn.sessionId,
    loaded: [...ctx.loaded, ...(review?.loaded ?? [])],
    ...(both.tokens ? { tokens: both.tokens } : {}),
    ...(both.costUsd !== undefined ? { cost_usd: both.costUsd } : {}),
    minutes: both.minutes,
    ...(both.turns !== undefined ? { turns: both.turns } : {}),
  });
  loadState(root); // state.json을 원장에 맞춘다

  const head = stop ? `${nodeId} 멈춤: ${stop}` : passed ? `${nodeId} 통과` : `${nodeId} 실패`;
  return {
    runId,
    passed,
    ...(cause ? { cause } : {}),
    ...(stop ? { stop } : {}),
    turn,
    ...(gate ? { gate } : {}),
    reverted: diff.violations,
    summary: [head, ...notes].join("\n"),
  };
}

// ---------------------------------------------------------------- 리뷰 세션 (N27, 승인 L1)

/** 리뷰 세션이 돌려줄 정해진 출력 형식. Codex의 엄격한 형식에도 맞게 모든 필드를 필수로 둔다. */
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    cause: { type: ["string", "null"], enum: ["code_bug", "arch_wrong", null] },
    // code_bug일 때 고칠 곳 (2026-11-25 오너 결정): 동작이 틀림 → N23, 동작은 맞고 구조만 다름 → N25, 인수 테스트가 덜 확인 → N22
    fix_in: { type: ["string", "null"], enum: ["behavior", "structure", "acceptance_test", null] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: ["integer", "null"] }, why: { type: "string" } },
        required: ["file", "line", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["pass", "cause", "fix_in", "findings"],
  additionalProperties: false,
} as const;

export interface ReviewVerdict {
  pass: boolean;
  cause: "code_bug" | "arch_wrong" | null;
  /** code_bug일 때 고칠 곳 */
  fixIn: "behavior" | "structure" | "acceptance_test" | null;
  findings: { file: string; line: number | null; why: string }[];
}

export function parseVerdict(v: unknown): ReviewVerdict | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.pass !== "boolean" || !Array.isArray(o.findings)) return null;
  const cause = o.cause === "code_bug" || o.cause === "arch_wrong" ? o.cause : null;
  const findings = o.findings
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({ file: String(f.file ?? ""), line: typeof f.line === "number" ? f.line : null, why: String(f.why ?? "") }));
  const c = o.pass ? null : (cause ?? "code_bug");
  // 고칠 곳을 답하지 않았으면, 지적이 모두 인수 테스트 파일을 가리킬 때만 인수 테스트로 본다.
  const testsOnly = findings.length > 0 && findings.every((f) => f.file.startsWith("tests/acceptance/"));
  const known = ["behavior", "structure", "acceptance_test"] as const;
  const given = known.find((k) => k === o.fix_in);
  const fixIn = c !== "code_bug" ? null : (given ?? (testsOnly ? "acceptance_test" : "behavior"));
  return { pass: o.pass, cause: c, fixIn, findings };
}

/** N27: 별도 리뷰 세션(읽기 전용, 매번 새 세션)이 변경분과 설계를 대조한다. */
export function runReviewNode(opts: SessionNodeOptions): SessionNodeOutcome & { verdict: ReviewVerdict | null } {
  const { root, nodes, nodeId, task } = opts;
  const node = getNode(nodes, nodeId);
  if (node.actor !== "reviewer") throw new Error(`${nodeId}는 리뷰 세션 노드가 아닙니다 (${node.actor})`);
  const H = nodes.version;
  const timeoutMs = opts.timeoutMs ?? nodes.defaults.turn_timeout_min * 60_000;
  const { events } = readEvents(root);
  const runId = nextId(events, "NR");
  appendEvent(root, H, { type: "node_start", id: runId, node: nodeId, task, session: null });

  const ctx = buildContext({ root, nodes, nodeId, task });
  const snap = ledgerSnapshot(root);
  const turn = opts.adapter.runTurn({
    root,
    prompt: ctx.prompt,
    sessionId: null,
    env: { FOURDD_ROOT: root, FOURDD_NODE: nodeId, FOURDD_NODE_RUN: runId },
    timeoutMs,
    readOnly: true,
    jsonSchema: REVIEW_SCHEMA,
  });

  let stop: string | undefined;
  const intact = ledgerIntact(root, snap);
  if (!intact.allowed) stop = `원장이 리뷰 세션 동안 바뀌었습니다: ${intact.reason}`;
  if (!stop && turn.ok && !readEvents(root).events.some((e) => e.type === "hook_run" && e.check === "session" && e.run === runId)) {
    stop = `훅이 돌지 않았습니다 (${opts.adapter.agent} 리뷰 세션 시작 기록 없음)`;
  }
  const diff = checkDiff(root, nodeId, runId, true, nodes);
  const verdict = turn.ok ? parseVerdict(turn.structured ?? safeJson(turn.text)) : null;

  let cause: Cause | undefined;
  const notes: string[] = [];
  if (!turn.ok) {
    cause = "env";
    notes.push(`리뷰 세션이 실패했습니다: ${turn.error ?? "알 수 없는 오류"}`);
  } else if (!verdict) {
    cause = "env";
    notes.push("리뷰 결과를 정해진 형식으로 읽지 못했습니다");
  } else if (!verdict.pass) {
    cause = verdict.cause ?? "code_bug";
    const where = verdict.fixIn ? ` · ${FIX_ROUTE[verdict.fixIn].label}` : "";
    notes.push(`설계와 다른 곳 (${cause}${where}):\n${verdict.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} ${f.why}`).join("\n")}`);
  }
  // 인수 테스트가 시나리오를 제대로 확인하지 않으면 원인 경로(N23) 대신 인수 테스트를 쓰는 N22로 보낸다.
  // 동작이 틀린 경우는 원인 경로(N23)대로 가고, 구조나 인수 테스트는 그 노드에서 고친 뒤 N26부터 다시 확인한다.
  const route = !passed0(stop, turn.ok, verdict, diff.violations.length) && verdict?.fixIn ? FIX_ROUTE[verdict.fixIn] : undefined;
  const nextOverride = route?.next;
  if (diff.violations.length) notes.push(diff.message);
  const passed = !stop && turn.ok && !!verdict?.pass && diff.violations.length === 0;
  const summary = [stop ? `${nodeId} 멈춤: ${stop}` : passed ? `${nodeId} 통과 (리뷰 세션)` : `${nodeId} 실패 (리뷰 세션)`, ...notes].join("\n");
  mkdirSync(join(root, GATE_DIR), { recursive: true });
  writeFileSync(join(root, GATE_DIR, `${runId}.summary.md`), summary + "\n", "utf8");

  appendEvent(root, H, {
    type: "node_end",
    id: runId,
    node: nodeId,
    task,
    result: stop ? "wait" : passed ? "pass" : "fail",
    ...(cause && !passed ? { cause } : {}),
    ...(nextOverride ? { next: nextOverride, then: "N26" } : {}),
    session: turn.sessionId,
    loaded: ctx.loaded,
    ...(turn.tokens ? { tokens: turn.tokens } : {}),
    ...(turn.costUsd !== undefined ? { cost_usd: turn.costUsd } : {}),
    minutes: turn.minutes,
    ...(turn.turns !== undefined ? { turns: turn.turns } : {}),
  });
  if (!passed && !stop && cause) {
    appendEvent(root, H, { type: "classify", run: runId, node: nodeId, cause, by: cause === "env" ? "harness" : "agent", needs_human: cause === "env" || cause === "arch_wrong" });
  }
  loadState(root);
  return { runId, passed, ...(cause ? { cause } : {}), ...(stop ? { stop } : {}), turn, reverted: diff.violations, summary, verdict };
}

function safeJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

function passed0(stop: string | undefined, ok: boolean, verdict: ReviewVerdict | null, violations: number): boolean {
  return !stop && ok && !!verdict?.pass && violations === 0;
}

/** 리뷰가 정한 고칠 곳별 경로 */
const FIX_ROUTE: Record<"behavior" | "structure" | "acceptance_test", { label: string; next?: string }> = {
  behavior: { label: "동작이 설계와 다름 (N23부터)" },
  structure: { label: "동작은 맞고 구조만 다름 (N25 리팩터 뒤 N26)", next: "N25" },
  acceptance_test: { label: "인수 테스트가 시나리오를 덜 확인함 (N22 뒤 N26)", next: "N22" },
};

// ---------------------------------------------------------------- 관문의 리뷰 세션 (조각 2: N13, N14, 승인 L1)

interface GateReview {
  passed: boolean;
  cause?: Cause;
  stop?: string;
  summary: string;
  turn?: TurnResult;
  loaded: ReturnType<typeof buildContext>["loaded"];
}

function sumTurns(a: TurnResult, b: TurnResult): TurnResult {
  const tokens =
    a.tokens || b.tokens
      ? {
          input: (a.tokens?.input ?? 0) + (b.tokens?.input ?? 0),
          output: (a.tokens?.output ?? 0) + (b.tokens?.output ?? 0),
          ...(a.tokens?.cached !== undefined || b.tokens?.cached !== undefined ? { cached: (a.tokens?.cached ?? 0) + (b.tokens?.cached ?? 0) } : {}),
        }
      : undefined;
  const cost = a.costUsd !== undefined || b.costUsd !== undefined ? (a.costUsd ?? 0) + (b.costUsd ?? 0) : undefined;
  const turns = a.turns !== undefined || b.turns !== undefined ? (a.turns ?? 0) + (b.turns ?? 0) : undefined;
  return { ...a, minutes: Math.round((a.minutes + b.minutes) * 100) / 100, ...(tokens ? { tokens } : {}), ...(cost !== undefined ? { costUsd: cost } : {}), ...(turns !== undefined ? { turns } : {}) };
}

/** 작업 세션이 쓴 것을 새 리뷰 세션(읽기 전용)이 판정한다. 지적은 관문 요약에 붙어 다음 차례의 맥락이 된다. */
function runGateReview(o: SessionNodeOptions & { feature: string | null; runId: string; env: Record<string, string>; timeoutMs: number; gateSummary: string }): GateReview {
  const { root, nodes, nodeId, task, feature, runId } = o;
  const node = getNode(nodes, nodeId);
  const rctx = buildContext({ root, nodes, nodeId, task, feature, instruction: node.gate!.review!, readOnly: true });
  const sessionsBefore = readEvents(root).events.filter((e) => e.type === "hook_run" && e.check === "session" && e.run === runId).length;
  const snap = ledgerSnapshot(root);
  const turn = o.adapter.runTurn({ root, prompt: rctx.prompt, sessionId: null, env: o.env, timeoutMs: o.timeoutMs, readOnly: true, jsonSchema: REVIEW_SCHEMA });
  const intact = ledgerIntact(root, snap);
  let stop: string | undefined;
  if (!intact.allowed) stop = `원장이 리뷰 세션 동안 바뀌었습니다: ${intact.reason}`;
  const sessionsAfter = readEvents(root).events.filter((e) => e.type === "hook_run" && e.check === "session" && e.run === runId).length;
  if (!stop && turn.ok && sessionsAfter <= sessionsBefore) stop = `훅이 돌지 않았습니다 (${o.adapter.agent} 리뷰 세션 시작 기록 없음)`;
  const diff = checkDiff(root, nodeId, runId, true, nodes, feature);
  const verdict = turn.ok ? parseVerdict(turn.structured ?? safeJson(turn.text)) : null;
  const notes: string[] = [];
  let cause: Cause | undefined;
  if (!turn.ok) {
    cause = "env";
    notes.push(`리뷰 세션이 실패했습니다: ${turn.error ?? "알 수 없는 오류"}`);
  } else if (!verdict) {
    cause = "env";
    notes.push("리뷰 결과를 정해진 형식으로 읽지 못했습니다");
  } else if (!verdict.pass) {
    notes.push(`리뷰 세션의 지적 (고친 뒤 다시 리뷰받습니다):\n${verdict.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} ${f.why}`).join("\n")}`);
  } else if (verdict.findings.length) {
    // 통과해도 참고 지적은 남긴다. 「스펙·시나리오 모순」은 검토 페이지가 PO에게 보여 준다
    notes.push(`${REVIEW_NOTE_HEAD}\n${verdict.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} ${f.why}`).join("\n")}`);
  }
  if (diff.violations.length) notes.push(diff.message);
  const passed = !stop && turn.ok && !!verdict?.pass && diff.violations.length === 0;
  const summary = [passed ? `${nodeId} 리뷰 세션 통과` : stop ? `${nodeId} 리뷰 멈춤: ${stop}` : `${nodeId} 리뷰 세션 실패`, ...notes].join("\n");
  mkdirSync(join(root, GATE_DIR), { recursive: true });
  writeFileSync(join(root, GATE_DIR, `${runId}.summary.md`), `${o.gateSummary}\n\n${summary}\n`, "utf8");
  return { passed, ...(cause ? { cause } : {}), ...(stop ? { stop } : {}), summary, turn, loaded: rctx.loaded };
}
