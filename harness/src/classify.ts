// 실패 원인 분류 (첫 구현 조각 명세 「실패 원인 분류」)
//
// 1. 기계가 정할 수 있으면 기계가 정한다 (관문이 test_flaky, env를 정함).
// 2. 아니면 그 작업의 세션에게 그 노드의 on_fail에 있는 단어만 고르게 한다 (정해진 출력 형식: 원인 하나와 근거 300자 이하).
//    세션은 읽기 전용으로 부르고, 고르지 못하면 그 노드의 첫 원인(code_bug)으로 둔다.
// 3. 사람 승인이 필요한 원인이면 멈춘다. 에이전트가 풀기 어려운 문제를 엉뚱한 원인으로 분류해 빠져나가지 못하게 하기 위해서다.

import type { Adapter, TurnResult } from "./adapters.ts";
import { checkDiff } from "./guard.ts";
import { allowedCauses, failRoute, type Cause, type NodeSet } from "./nodes.ts";

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

export function classifySchema(causes: Cause[]) {
  return {
    type: "object",
    properties: { cause: { type: "string", enum: causes }, evidence: { type: "string", maxLength: 300 } },
    required: ["cause", "evidence"],
    additionalProperties: false,
  };
}

export function classifyPrompt(nodeId: string, task: string, causes: Cause[], gateSummary: string): string {
  return [
    `# 4DD 하네스 · ${nodeId} 실패 원인 분류 · 작업 ${task}`,
    "하네스의 관문이 실패했습니다. 파일은 고치지 말고, 아래 단어 가운데 원인 하나만 고르세요. 근거는 한국어로 300자 이내로 씁니다.",
    "앞 스테이지(스펙, 설계)로 가는 원인은 사람이 승인해야 진행합니다. 확실하지 않으면 code_bug를 고릅니다.",
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
  by: "harness" | "agent";
  needsHuman: boolean;
  evidence: string;
  turn?: TurnResult;
}

/** 사람에게 가는 원인인가 (그 노드의 on_fail에서 goto가 human) */
export function needsHuman(nodes: NodeSet, nodeId: string, cause: Cause): boolean {
  if (cause === "env" || cause === "budget_exceeded") return true;
  return failRoute(nodes, nodeId, cause)?.goto === "human";
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
  /** 그 작업의 세션 (없으면 에이전트 분류를 건너뛰고 기본 원인) */
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
  const turn = opts.adapter.runTurn({
    root: opts.root,
    prompt: classifyPrompt(nodeId, opts.task, causes, opts.gateSummary),
    sessionId: opts.session,
    env: { FOURDD_ROOT: opts.root, FOURDD_NODE: nodeId, FOURDD_NODE_RUN: opts.runId },
    timeoutMs: opts.timeoutMs ?? nodes.defaults.turn_timeout_min * 60_000,
    readOnly: true,
    jsonSchema: classifySchema(causes),
  });
  // 분류 차례에서 파일을 고쳤으면 되돌린다 (판단 노드는 아무것도 고칠 수 없다).
  checkDiff(opts.root, nodeId, opts.runId, true, nodes);
  const picked = (turn.structured ?? {}) as { cause?: unknown; evidence?: unknown };
  const cause = typeof picked.cause === "string" && (causes as string[]).includes(picked.cause) ? (picked.cause as Cause) : fallback;
  const evidence = typeof picked.evidence === "string" ? picked.evidence.slice(0, 300) : "";
  return { cause, by: turn.ok && cause === picked.cause ? "agent" : "harness", needsHuman: needsHuman(nodes, nodeId, cause), evidence, turn };
}
