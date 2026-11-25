// 세션 노드 한 차례: 노드 진입 기록 → 맥락 → 세션 한 차례 → 원장 지키기 → 훅 확인 → 차례 뒤 변경 검사 → 관문 → 노드 종료 기록
//
// 지휘 프로그램(4dd run)은 이 함수를 노드마다 부르고, 통과하면 커밋하고 다음 노드로 간다.

import type { Adapter, TurnResult } from "./adapters.ts";
import type { Config } from "./config.ts";
import { buildContext } from "./context.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_DIR, runGate, type GateOutcome } from "./gate.ts";
import { checkDiff } from "./guard.ts";
import { appendEvent, nextId, readEvents } from "./ledger.ts";
import { ledgerIntact, ledgerSnapshot } from "./lock.ts";
import { getNode, type Cause, type NodeSet } from "./nodes.ts";
import { loadState } from "./state.ts";

export interface SessionNodeOptions {
  root: string;
  config: Config;
  nodes: NodeSet;
  nodeId: string;
  task: string;
  adapter: Adapter;
  timeoutMs?: number;
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
  const node = getNode(nodes, nodeId);
  if (node.actor !== "worker") throw new Error(`${nodeId}는 작업 세션 노드가 아닙니다 (${node.actor})`);
  const H = nodes.version;
  const timeoutMs = opts.timeoutMs ?? nodes.defaults.turn_timeout_min * 60_000;

  const { events } = readEvents(root);
  const { state } = loadState(root);
  const runId = nextId(events, "NR");
  const session = state.task === task ? state.session : null;
  appendEvent(root, H, { type: "node_start", id: runId, node: nodeId, task, session });

  const ctx = buildContext({ root, nodes, nodeId, task });
  const snap = ledgerSnapshot(root);
  const turn = opts.adapter.runTurn({
    root,
    prompt: ctx.prompt,
    sessionId: session,
    env: { FOURDD_ROOT: root, FOURDD_NODE: nodeId, FOURDD_NODE_RUN: runId },
    timeoutMs,
  });

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
  const diff = checkDiff(root, nodeId, runId, true, nodes);
  if (diff.violations.length) notes.push(diff.message);

  // 5. 관문
  let gate: GateOutcome | undefined;
  if (!stop && turn.ok && node.gate) {
    gate = runGate({ root, config: opts.config, nodes, nodeId, task, runId });
    if (gate.cause) cause = gate.cause;
    notes.push(gate.summary);
  }

  const passed = !stop && turn.ok && diff.violations.length === 0 && (gate?.passed ?? true);
  appendEvent(root, H, {
    type: "node_end",
    id: runId,
    node: nodeId,
    task,
    result: stop ? "wait" : passed ? "pass" : "fail",
    ...(cause && !passed ? { cause } : {}),
    session: turn.sessionId,
    loaded: ctx.loaded,
    ...(turn.tokens ? { tokens: turn.tokens } : {}),
    ...(turn.costUsd !== undefined ? { cost_usd: turn.costUsd } : {}),
    minutes: turn.minutes,
    ...(turn.turns !== undefined ? { turns: turn.turns } : {}),
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
  required: ["pass", "cause", "findings"],
  additionalProperties: false,
} as const;

export interface ReviewVerdict {
  pass: boolean;
  cause: "code_bug" | "arch_wrong" | null;
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
  return { pass: o.pass, cause: o.pass ? null : (cause ?? "code_bug"), findings };
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
    notes.push(`설계와 다른 곳 (${cause}):\n${verdict.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} ${f.why}`).join("\n")}`);
  }
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
