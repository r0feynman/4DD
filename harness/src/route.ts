// 다음에 할 일 정하기. 원장만 보고 정하므로, 지휘 프로그램이 죽었다 살아나도 같은 답이 나온다.
//
//   통과 → 파일 순서의 다음 노드 (판단 노드가 실패해 간 곳이면 then으로)
//   작업 노드 실패 → 같은 노드 다시
//   판단 노드 실패 → 실패 원인별로 갈 곳 (사람에게 가는 원인이면 사람을 기다림)
//   사람 개입 뒤 → 승인이면 then, 힌트면 다시 시도, 분류 바로잡기면 새 원인의 경로, 보류면 다음 작업

import type { LedgerEvent } from "./ledger.ts";
import { failRoute, getNode, nextNode, type Cause, type NodeSet, type WorkType } from "./nodes.ts";
import type { State } from "./state.ts";

export type Step =
  | { kind: "pick" }
  | { kind: "node"; node: string }
  | { kind: "human"; node: string; reason: string };

type NodeEnd = Extract<LedgerEvent, { type: "node_end" }>;
type Human = Extract<LedgerEvent, { type: "human" }>;

const causeOf = (e: NodeEnd): Cause => e.cause ?? "code_bug";

/** 판단 노드가 실패해 고치러 간 노드를 통과했을 때, then이 있으면 그리로 간다 (예: test_flaky → N22 → N26). */
function pendingThen(nodes: NodeSet, ends: NodeEnd[]): string | null {
  const last = ends.at(-1);
  if (!last) return null;
  for (let i = ends.length - 2; i >= 0; i--) {
    const e = ends[i];
    if (e.result === "fail" && nodes.nodes[e.node]?.kind === "decision") {
      const onlyRetries = ends.slice(i + 1, -1).every((x) => x.node === last.node);
      // 하네스가 갈 곳과 이어서 갈 곳을 직접 정해 두었으면 그것을 따른다 (N27 → N22 → N26)
      if (e.next) return e.next === last.node && e.then && onlyRetries ? e.then : null;
      const r = failRoute(nodes, e.node, causeOf(e));
      return r && r.goto === last.node && r.then && onlyRetries ? r.then : null;
    }
    if (e.result === "pass" && e.node !== last.node) return null;
  }
  return null;
}

/** 실패한 노드를 다시 시도할 곳: 작업 노드는 그 노드, 판단 노드는 그 원인으로 고치러 가는 노드 */
function retryTarget(nodes: NodeSet, end: NodeEnd): string {
  if (getNode(nodes, end.node).kind === "work") return end.node;
  const r = failRoute(nodes, end.node, causeOf(end));
  return r && r.goto !== "human" ? r.goto : end.node;
}

function afterHuman(nodes: NodeSet, h: Human, end: NodeEnd): Step {
  switch (h.kind) {
    case "hold":
      return { kind: "pick" };
    case "hint":
      return { kind: "node", node: retryTarget(nodes, end) };
    case "reclassify": {
      const cause = h.cause ?? causeOf(end);
      if (getNode(nodes, end.node).kind === "work") return { kind: "node", node: end.node };
      const r = failRoute(nodes, end.node, cause);
      if (!r) return { kind: "human", node: end.node, reason: cause };
      return r.goto === "human" ? { kind: "human", node: end.node, reason: cause } : { kind: "node", node: r.goto };
    }
    default: {
      // approve, edit, reject: 사람이 고치거나 승인했다.
      const reason = h.reason ?? end.cause;
      if (!reason || reason === "budget_exceeded" || reason === "env" || getNode(nodes, end.node).kind === "work") {
        return { kind: "node", node: retryTarget(nodes, end) };
      }
      const r = failRoute(nodes, end.node, reason as Cause);
      return { kind: "node", node: r?.then ?? (r && r.goto !== "human" ? r.goto : end.node) };
    }
  }
}

export function decideNext(events: LedgerEvent[], nodes: NodeSet, workType: WorkType, state: State): Step {
  if (state.status === "waiting_human" && state.waiting) return { kind: "human", node: state.waiting.node, reason: state.waiting.reason };
  if (state.status === "stopped") return { kind: "human", node: state.node ?? "N21", reason: "stopped" };
  if (!state.task) return { kind: "pick" };

  const idx = events.findLastIndex((e) => e.type === "node_end" && e.task === state.task);
  if (idx < 0) return { kind: "pick" };
  const end = events[idx] as NodeEnd;
  const human = events.slice(idx + 1).filter((e): e is Human => e.type === "human").at(-1);
  if (human) return afterHuman(nodes, human, end);

  if (end.result === "wait") return { kind: "human", node: end.node, reason: end.cause ?? "env" };
  if (end.result === "pass") {
    if (end.task_done) return { kind: "pick" };
    // 이미 충족: 앞 작업의 구현으로 시나리오가 이미 통과하면 정해진 곳(N26)으로 바로 간다.
    const metTarget = end.already_met ? nodes.nodes[end.node]?.gate?.already_met : undefined;
    if (metTarget) return { kind: "node", node: metTarget };
    const ends = events.filter((e): e is NodeEnd => e.type === "node_end" && e.task === state.task);
    const then = pendingThen(nodes, ends);
    if (then) return { kind: "node", node: then };
    const next = nextNode(nodes, end.node, workType);
    return next ? { kind: "node", node: next } : { kind: "pick" };
  }
  // 실패
  if (getNode(nodes, end.node).kind === "work") return { kind: "node", node: end.node };
  // 하네스가 원인 경로 대신 갈 곳을 정해 두었으면 그리로 (N27이 인수 테스트를 고치라고 함 → N22)
  if (end.next) return { kind: "node", node: end.next };
  const r = failRoute(nodes, end.node, causeOf(end));
  if (!r || r.goto === "human") return { kind: "human", node: end.node, reason: causeOf(end) };
  return { kind: "node", node: r.goto };
}
