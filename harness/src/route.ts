// 다음에 할 일 정하기. 원장만 보고 정하므로, 지휘 프로그램이 죽었다 살아나도 같은 답이 나온다.
//
//   일감: Stage 2에서는 작업(T4), Stage 0·1에서는 기능(password-reset, 작업이 아직 없음)
//   통과 → 파일 순서의 다음 노드 (판단 노드가 실패해 간 곳이면 then으로). 사람 승인 노드면 승인을 기다림
//   작업 노드 실패 → 같은 노드 다시
//   판단 노드 실패 → 실패 원인별로 갈 곳 (사람에게 가는 원인이나 앞 스테이지로 가는 원인이면 사람을 기다림)
//   사람 개입 뒤 → 승인이면 then, 힌트면 다시 시도, 분류 바로잡기면 새 원인의 경로로, 보류면 다음 작업
//     작업 노드(N24 등)가 횟수 제한을 넘었는데 사람이 앞 스테이지 원인(스펙·설계)으로 바로잡으면,
//     같은 스테이지 뒤 판단 노드(N26, N27)의 그 원인 경로를 쓴다 (사람 승인 뒤 N02 → N04 → 원래 작업의 N22)
//   검토 승인(조각 2) → 다음 노드. 앞 스테이지로 돌아갔던 작업이면 처음 실패한 곳의 then으로 돌아옴

import type { LedgerEvent } from "./ledger.ts";
import { failRoute, getNode, goesBack, nextNode, stageRoute, type Cause, type NodeSet, type WorkType } from "./nodes.ts";
import type { State } from "./state.ts";

export type Step =
  | { kind: "pick" }
  | { kind: "node"; node: string }
  /** reason: 실패 원인, review(검토 승인을 기다림), story(스토리를 기다림), not_ready(N12), stopped */
  | { kind: "human"; node: string; reason: string };

type NodeEnd = Extract<LedgerEvent, { type: "node_end" }>;
type Human = Extract<LedgerEvent, { type: "human" }>;

const causeOf = (e: NodeEnd): Cause => e.cause ?? "code_bug";

/** N21로 가라는 것은 다음 작업을 고르라는 것이다 */
const toStep = (node: string): Step => (node === "N21" ? { kind: "pick" } : { kind: "node", node });

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
      // 앞 스테이지로 간 경로의 then은 고친 노드 다음이 아니라 다음 승인 뒤에 쓴다
      if (r && nodes.nodes[r.goto] && nodes.nodes[r.goto].stage < nodes.nodes[e.node].stage) return null;
      return r && r.goto === last.node && r.then && onlyRetries ? r.then : null;
    }
    if (e.result === "pass" && e.node !== last.node) return null;
  }
  return null;
}

/** 원인이 정해진 실패 하나: 판단 노드의 실패, 또는 사람이 작업 노드(N24 등)의 원인을 바로잡은 것 */
type Failure = { node: string; cause: Cause };

/** 이 일감에서 원인이 정해진 실패를 원장 순서대로 */
function unitFailures(events: LedgerEvent[], nodes: NodeSet, state: State): Failure[] {
  const out: Failure[] = [];
  for (const e of events) {
    if (e.type === "node_end" && inUnit(e, state) && e.result === "fail" && nodes.nodes[e.node]?.kind === "decision") {
      out.push({ node: e.node, cause: causeOf(e) });
    } else if (e.type === "human" && e.kind === "reclassify" && e.cause && state.task && e.task === state.task) {
      out.push({ node: e.node, cause: e.cause });
    }
  }
  return out;
}

/** 앞 스테이지(스펙, 설계)로 돌아갔던 작업이 다시 승인받았을 때 돌아올 곳: 앞 스테이지로 보낸 마지막 실패 경로의 then */
function excursionReturn(nodes: NodeSet, failures: Failure[]): string {
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i];
    const r = stageRoute(nodes, f.node, f.cause);
    if (r?.then && goesBack(nodes, f.node, r)) return r.then;
  }
  return "N21";
}

/** 실패한 노드를 다시 시도할 곳: 작업 노드는 그 노드, 판단 노드는 그 원인으로 고치러 가는 노드 */
function retryTarget(nodes: NodeSet, end: NodeEnd): string {
  if (getNode(nodes, end.node).kind === "work") return end.node;
  const r = failRoute(nodes, end.node, causeOf(end));
  return r && r.goto !== "human" ? r.goto : end.node;
}

function afterReview(nodes: NodeSet, h: Human, end: NodeEnd, failures: Failure[], state: State, workType: WorkType): Step {
  const node = getNode(nodes, end.node);
  if (h.kind === "approve") {
    // Stage 2에서 돌아왔던 작업이면, 승인 뒤 원래 자리로 (스펙 → N22, 설계 → 다음 작업 고르기)
    if (state.task) return toStep(excursionReturn(nodes, failures));
    if (node.approve?.packet === "1-2") return { kind: "pick" };
    const next = nextNode(nodes, end.node, workType);
    return next ? toStep(next) : { kind: "pick" };
  }
  // 되돌림: 판단 노드(N04)는 원인별 경로로, 작업 노드(N15)는 사람이 고른 노드로
  if (node.kind === "decision") {
    const r = h.cause ? failRoute(nodes, end.node, h.cause) : null;
    return r && r.goto !== "human" ? { kind: "node", node: r.goto } : { kind: "human", node: end.node, reason: "review" };
  }
  return h.to ? { kind: "node", node: h.to } : { kind: "human", node: end.node, reason: "review" };
}

function afterHuman(nodes: NodeSet, h: Human, end: NodeEnd, failures: Failure[], state: State, workType: WorkType): Step {
  if (h.review && (h.kind === "approve" || h.kind === "reject")) return afterReview(nodes, h, end, failures, state, workType);
  switch (h.kind) {
    case "story":
      // 스토리를 다시 받았다 (N12가 준비 안 됨으로 N01에 보냄): 스펙부터
      return { kind: "node", node: nextNode(nodes, "N01", workType) ?? "N02" };
    case "hold":
      return { kind: "pick" };
    case "hint":
      return { kind: "node", node: retryTarget(nodes, end) };
    case "reclassify": {
      const cause = h.cause ?? causeOf(end);
      const r = stageRoute(nodes, end.node, cause);
      // 작업 노드는 같은 노드를 다시 한다. 다만 사람이 앞 스테이지 원인(스펙·설계)으로 바로잡으면 그 경로로 (사람 승인 뒤)
      if (getNode(nodes, end.node).kind === "work" && !goesBack(nodes, end.node, r)) return { kind: "node", node: end.node };
      if (!r || r.goto === "human" || r.confirm) return { kind: "human", node: end.node, reason: cause };
      return { kind: "node", node: r.goto };
    }
    default: {
      // approve, edit, reject: 사람이 고치거나 승인했다.
      const reason = h.reason ?? end.cause;
      const n = getNode(nodes, end.node);
      if (end.result === "fail" && n.kind === "decision" && !end.cause && n.otherwise) {
        // 원인 단어 없이 실패한 판단 노드(N12): 승인 뒤 otherwise의 then으로
        return toStep(n.otherwise.then ?? end.node);
      }
      if (n.kind === "work" && reason && reason !== "budget_exceeded" && reason !== "env") {
        // 사람이 작업 노드의 실패를 앞 스테이지 원인으로 바로잡고 승인했다: 그 노드부터 고친다
        const back = stageRoute(nodes, end.node, reason as Cause);
        if (back && goesBack(nodes, end.node, back)) return { kind: "node", node: back.goto };
      }
      if (!reason || reason === "budget_exceeded" || reason === "env" || n.kind === "work") {
        return { kind: "node", node: retryTarget(nodes, end) };
      }
      const r = failRoute(nodes, end.node, reason as Cause);
      // 앞 스테이지로 가는 원인을 사람이 승인했다: 그 노드부터 고친다 (then은 다음 승인 뒤에 씀)
      if (r?.confirm && r.goto !== "human") return { kind: "node", node: r.goto };
      return toStep(r?.then ?? (r && r.goto !== "human" ? r.goto : end.node));
    }
  }
}

/** 이 일감의 노드 기록인가: 작업이 있으면 그 작업, 없으면 Stage 0·1을 도는 기능 */
function inUnit(e: LedgerEvent, state: State): e is NodeEnd {
  if (e.type !== "node_end") return false;
  return state.task ? e.task === state.task : e.task === null && !!e.feature && e.feature === state.planning;
}

export function decideNext(events: LedgerEvent[], nodes: NodeSet, workType: WorkType, state: State): Step {
  if (state.status === "waiting_human" && state.waiting) return { kind: "human", node: state.waiting.node, reason: state.waiting.reason };
  if (state.status === "stopped") return { kind: "human", node: state.node ?? "N21", reason: "stopped" };
  if (!state.task && !state.planning) return { kind: "pick" };

  const idx = events.findLastIndex((e) => inUnit(e, state));
  // 기능의 첫 노드: 스토리(N01) 다음
  if (idx < 0) return state.task ? { kind: "pick" } : { kind: "node", node: nextNode(nodes, "N01", workType) ?? "N02" };
  const end = events[idx] as NodeEnd;
  const ends = events.filter((e): e is NodeEnd => inUnit(e, state));
  const human = events.slice(idx + 1).filter((e): e is Human => e.type === "human").at(-1);
  if (human) return afterHuman(nodes, human, end, unitFailures(events, nodes, state), state, workType);

  const node = getNode(nodes, end.node);
  if (end.result === "wait") return { kind: "human", node: end.node, reason: node.approve ? "review" : (end.cause ?? "env") };
  if (end.result === "pass") {
    if (end.task_done) return { kind: "pick" };
    // 사람 승인이 있는 작업 노드(N15)는 통과하면 검토 승인을 기다린다
    if (node.approve) return { kind: "human", node: end.node, reason: "review" };
    // 이미 충족: 앞 작업의 구현으로 시나리오가 이미 통과하면 정해진 곳(N26)으로 바로 간다.
    const metTarget = end.already_met ? node.gate?.already_met : undefined;
    if (metTarget) return { kind: "node", node: metTarget };
    const then = pendingThen(nodes, ends);
    if (then) return toStep(then);
    const next = nextNode(nodes, end.node, workType);
    return next ? toStep(next) : { kind: "pick" };
  }
  // 실패
  if (node.kind === "work") return { kind: "node", node: end.node };
  // 하네스가 원인 경로 대신 갈 곳을 정해 두었으면 그리로 (N27이 인수 테스트를 고치라고 함 → N22)
  if (end.next) return { kind: "node", node: end.next };
  // 원인 단어 없이 실패하는 판단 노드 (N12 → 사람)
  if (!end.cause && node.otherwise) {
    return node.otherwise.goto === "human" ? { kind: "human", node: end.node, reason: "not_ready" } : toStep(node.otherwise.goto);
  }
  const r = failRoute(nodes, end.node, causeOf(end));
  if (!r || r.goto === "human" || r.confirm) return { kind: "human", node: end.node, reason: causeOf(end) };
  return { kind: "node", node: r.goto };
}
