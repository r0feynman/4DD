// 실패 원인 분류 (첫 구현 조각 명세 「실패 원인 분류」)
//
// 1. 기계가 정할 수 있으면 기계가 정한다 (관문이 test_flaky, env를 정함).
// 2. 아니면 읽기 전용 새 세션에게 그 노드의 on_fail에 있는 단어만 고르게 한다 (정해진 출력 형식: 원인 하나와 근거 300자 이하).
//    고르지 못하면 그 노드의 첫 원인(code_bug)으로 둔다.
// 3. 사람 승인이 필요한 원인이면 멈춘다. 에이전트가 풀기 어려운 문제를 엉뚱한 원인으로 분류해 빠져나가지 못하게 하기 위해서다.

import type { Adapter, TurnResult } from "./adapters.ts";
import { checkDiff } from "./guard.ts";
import { allowedCauses, failRoute, type Cause, type NodeSet } from "./nodes.ts";
import { checkProject } from "./trace.ts";

/** 원인 단어의 뜻 (workflow.md 「실패 원인」을 줄인 것). 분류 차례에서 에이전트에게 보여 준다. */
export const CAUSE_MEANING: Record<Cause, string> = {
  code_bug: "코드가 틀림. 스펙과 설계대로 고치면 맞출 수 있음",
  ui_mismatch: "화면이 프레임과 다름. 프레임대로 고치면 맞출 수 있음",
  spec_ambiguous: "스펙이 모호해서 무엇이 맞는지 정할 수 없음",
  spec_missing_state: "스펙에 빠진 상태가 있음",
  design_missing_state: "그리지 않은 화면 상태가 있음",
  design_wrong: "프레임 자체가 틀려서 프레임대로는 구현할 수 없음",
  arch_wrong: "설계 스펙(design.md) 자체가 틀려서 설계대로는 구현할 수 없음",
  test_flaky: "테스트가 불안정함 (같은 코드인데 결과가 바뀜)",
  env: "실행 환경 문제 (빌드 도구, 명령 실행 실패)",
  budget_exceeded: "횟수 제한 초과",
};

/**
 * code_bug일 때 고칠 곳을 더 고르는 노드 (조각 3, 2026-11-27 실제 실행).
 * N26F에서 찍은 화면이 앱의 끝 화면이 아니면(앱이 닫혀 홈 화면이 찍힘) 앱이 아니라 플로우를 고쳐야 한다.
 * N26에서 플로우 스크립트가 앱을 만지기 전에 깨지면(Maestro http.post에 본문이 없음) 구현 노드는 고칠 수 없다.
 */
const FLOW_FIX = { flow: { label: "플로우(인수 테스트)를 고침 (N22 뒤 N26)", next: "N22", then: "N26" } };
export const CLASSIFY_FIX: Record<string, { flow: { label: string; next: string; then: string } }> = {
  N26: FLOW_FIX,
  N26F: FLOW_FIX,
};

export function classifySchema(causes: Cause[], withFix = false) {
  return {
    type: "object",
    properties: {
      cause: { type: "string", enum: causes },
      evidence: { type: "string", maxLength: 300 },
      ...(withFix ? { fix_in: { type: ["string", "null"], enum: ["app", "flow", null] } } : {}),
    },
    required: ["cause", "evidence", ...(withFix ? ["fix_in"] : [])],
    additionalProperties: false,
  };
}

/** 노드별로 원인을 고를 때 볼 것 (조각 3: 화면 비교는 이미지를 열어 봐야 가를 수 있음) */
const CLASSIFY_HINT: Record<string, string> = {
  N26: [
    "관문 결과에 적힌 출력 파일(.4dd/gates/GR….log)을 Read로 열어, 플로우가 어느 단계에서 멈췄는지 봅니다.",
    "- 앱이 스펙대로 움직이지 않으면(안내가 안 나옴, 다음 화면으로 안 감, 요소가 없음) `code_bug`, `fix_in`은 `app`",
    "- 플로우·테스트 자체가 깨졌으면 `code_bug`, `fix_in`은 `flow`(N22에서 인수 테스트를 고침): 앱을 만지기 전에 플로우의 스크립트가 오류로 멈춤(runScript, http 호출, 문법), 한 플랫폼의 플로우만 스크립트 오류로 깨짐, 테스트가 스펙과 다른 것을 확인함",
    "- 같은 코드인데 결과가 바뀌면 `test_flaky`. 다른 원인이면 `fix_in`은 null",
  ].join("\n"),
  N26F: [
    "관문 결과에 적힌 세 이미지(차이 이미지, 기준 프레임, 찍은 화면)를 Read로 열어 봅니다.",
    "- 프레임대로 고치면 맞출 수 있으면(색, 간격, 글자 크기, 문구, 배치) `ui_mismatch`",
    "- 기준 프레임은 기능을 다 만든 끝 화면입니다. 찍은 화면에 프레임의 요소(칸, 안내, 버튼)가 아직 없으면, 작업 목록상 뒤 작업의 몫이어도 이 작업에서 만들면 맞출 수 있으므로 `ui_mismatch`입니다. `design_missing_state`는 스펙의 상태가 프레임으로 그려지지 않았을 때만 고릅니다(작업 중간 상태는 그리지 않음)",
    "- 화면에 나와야 할 상태 자체가 틀리면(로그인이 안 됨, 안내가 안 나옴) `code_bug`",
    "- 프레임 자체가 틀려서 프레임대로는 구현할 수 없으면 `design_wrong` (사람 승인). 구현을 고치는 대신 프레임을 바꿔 통과하려는 것이면 안 됩니다",
    "- 찍은 화면이 앱의 끝 화면이 아니거나(홈 화면, 다른 화면, 키보드가 가림), 찍은 화면이 없거나 크기가 다르면 `code_bug`입니다. 이때 고칠 곳(`fix_in`)도 고릅니다: 플로우가 앱을 닫거나 엉뚱한 때에 찍었으면 `flow`(N22에서 플로우를 고침), 앱이 뜨지 않거나 죽었으면 `app`",
    "- 그 밖의 `code_bug`는 `fix_in`을 `app`으로 둡니다. 다른 원인이면 `fix_in`은 null",
  ].join("\n"),
};

export function classifyPrompt(nodeId: string, task: string, causes: Cause[], gateSummary: string, taskLine?: string): string {
  return [
    `# 4DD 하네스 · ${nodeId} 실패 원인 분류 · 작업 ${task}`,
    "하네스의 관문이 실패했습니다. 파일은 고치지 말고, 아래 단어 가운데 원인 하나만 고르세요. 근거는 한국어로 300자 이내로 씁니다.",
    "앞 스테이지(스펙, 설계)로 가는 원인은 사람이 승인해야 진행합니다. 확실하지 않으면 code_bug를 고릅니다.",
    "이 세션은 분류만 하려고 새로 열었습니다. 작업 세션의 기억이 없으므로, 관문 결과에 적힌 출력 파일·이미지와 필요한 코드·스펙을 Read로 봅니다.",
    ...(taskLine ? ["", "## 이 작업", taskLine] : []),
    ...(CLASSIFY_HINT[nodeId] ? ["", "## 이 노드에서 고르는 법", CLASSIFY_HINT[nodeId]] : []),
    "",
    "## 고를 수 있는 원인",
    ...causes.map((c) => `- \`${c}\`: ${CAUSE_MEANING[c]}`),
    "",
    "## 관문 결과",
    gateSummary.trim(),
  ].join("\n");
}

export interface ClassifyResult {
  cause: Cause;
  /** 고칠 곳이 정해진 경로와 다를 때 갈 노드와 그 뒤 노드 (N26F의 플로우 문제 → N22 → N26) */
  next?: string;
  then?: string;
  by: "harness" | "agent";
  needsHuman: boolean;
  evidence: string;
  turn?: TurnResult;
}

/** 사람에게 가는 원인인가 (그 노드의 on_fail에서 goto가 human이거나, 앞 스테이지로 돌아가 사람이 먼저 승인해야 하는 경로) */
export function needsHuman(nodes: NodeSet, nodeId: string, cause: Cause): boolean {
  if (cause === "env" || cause === "budget_exceeded") return true;
  const r = failRoute(nodes, nodeId, cause);
  return r?.goto === "human" || r?.confirm === true;
}

export interface ClassifyOptions {
  root: string;
  nodes: NodeSet;
  nodeId: string;
  task: string;
  runId: string;
  /** 관문이 기계로 정한 원인 */
  machineCause?: Cause;
  gateSummary: string;
  /** 그 작업의 세션. 작업 세션이 돈 적이 없으면 에이전트 분류를 건너뛰고 기본 원인 (분류 자체는 새 세션에서 함) */
  session: string | null;
  adapter?: Adapter;
  timeoutMs?: number;
}

export function classifyFailure(opts: ClassifyOptions): ClassifyResult {
  const { nodes, nodeId } = opts;
  const causes = allowedCauses(nodes, nodeId);
  const fallback = causes[0] ?? "code_bug";
  if (opts.machineCause) {
    return { cause: opts.machineCause, by: "harness", needsHuman: needsHuman(nodes, nodeId, opts.machineCause), evidence: "관문이 정함" };
  }
  if (!opts.adapter || !opts.session || causes.length <= 1) {
    return { cause: fallback, by: "harness", needsHuman: needsHuman(nodes, nodeId, fallback), evidence: "기본 원인" };
  }
  // 새 세션으로 고른다 (2026-11-27 실제 실행): 작업 세션을 이어 쓰면 판단 노드의 긴 관문(Android 플로우) 사이에 캐시가 식고
  // 읽기 전용 도구 목록도 달라, 쌓인 맥락 수십만 토큰을 차례마다 새로 읽었다 (분류 한 번 $1~2)
  const t = checkProject(opts.root).flatMap((x) => x.tasks).find((x) => x.id === opts.task);
  const turn = opts.adapter.runTurn({
    root: opts.root,
    prompt: classifyPrompt(nodeId, opts.task, causes, opts.gateSummary, t ? `${t.id} ${t.title} (${t.file})` : undefined),
    sessionId: null,
    env: { FOURDD_ROOT: opts.root, FOURDD_NODE: nodeId, FOURDD_NODE_RUN: opts.runId },
    timeoutMs: opts.timeoutMs ?? nodes.defaults.turn_timeout_min * 60_000,
    readOnly: true,
    jsonSchema: classifySchema(causes, !!CLASSIFY_FIX[nodeId]),
  });
  // 분류 차례에서 파일을 고쳤으면 되돌린다 (판단 노드는 아무것도 고칠 수 없다).
  checkDiff(opts.root, nodeId, opts.runId, true, nodes);
  const picked = (turn.structured ?? {}) as { cause?: unknown; evidence?: unknown; fix_in?: unknown };
  const cause = typeof picked.cause === "string" && (causes as string[]).includes(picked.cause) ? (picked.cause as Cause) : fallback;
  const evidence = typeof picked.evidence === "string" ? picked.evidence.slice(0, 300) : "";
  const fix = cause === "code_bug" && picked.fix_in === "flow" ? CLASSIFY_FIX[nodeId]?.flow : undefined;
  return {
    cause,
    by: turn.ok && cause === picked.cause ? "agent" : "harness",
    needsHuman: needsHuman(nodes, nodeId, cause),
    evidence: fix ? `${evidence} → ${fix.label}` : evidence,
    ...(fix ? { next: fix.next, then: fix.then } : {}),
    turn,
  };
}
