import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { decideNext } from "../src/route.ts";
import { rebuildState } from "../src/state.ts";

const nodes = loadNodes();
const base = { ts: "2026-11-25T00:00:00.000Z", schema_version: 1 as const, harness: "0.1.0" };
let n = 0;
type End = { node: string; result: "pass" | "fail" | "wait"; cause?: string; task_done?: boolean };
const end = (e: End): LedgerEvent => {
  n++;
  return { ...base, type: "node_end", id: `NR${n}`, node: e.node, task: "T1", result: e.result, loaded: [], minutes: 0, ...(e.cause ? { cause: e.cause } : {}), ...(e.task_done ? { task_done: true } : {}) } as LedgerEvent;
};
const human = (kind: string, extra: Record<string, unknown> = {}): LedgerEvent => ({ ...base, type: "human", id: `HU${++n}`, node: "N26", task: "T1", kind, ...extra }) as LedgerEvent;
const classify = (node: string, cause: string, needs: boolean): LedgerEvent => ({ ...base, type: "classify", run: `NR${n}`, node, cause, by: "harness", needs_human: needs }) as LedgerEvent;

function next(events: LedgerEvent[]) {
  return decideNext(events, nodes, "backend", rebuildState(events));
}
const picked = (): LedgerEvent[] => [end({ node: "N21", result: "pass" })];

describe("다음 할 일 정하기", () => {
  it("작업이 없으면 고르고, 통과하면 다음 노드", () => {
    expect(next([])).toEqual({ kind: "pick" });
    expect(next(picked())).toEqual({ kind: "node", node: "N22" });
    expect(next([...picked(), end({ node: "N25", result: "pass" })])).toEqual({ kind: "node", node: "N26" });
    expect(next([...picked(), end({ node: "N26", result: "pass" })])).toEqual({ kind: "node", node: "N27" });
  });

  it("작업을 끝내면 다음 작업을 고른다", () => {
    expect(next([...picked(), end({ node: "N29", result: "pass", task_done: true })])).toEqual({ kind: "pick" });
  });

  it("작업 노드가 실패하면 같은 노드를 다시", () => {
    expect(next([...picked(), end({ node: "N24", result: "fail" })])).toEqual({ kind: "node", node: "N24" });
  });

  it("판단 노드는 실패 원인별로", () => {
    expect(next([...picked(), end({ node: "N26", result: "fail", cause: "code_bug" })])).toEqual({ kind: "node", node: "N23" });
    expect(next([...picked(), end({ node: "N28", result: "fail", cause: "code_bug" })])).toEqual({ kind: "node", node: "N23" });
    expect(next([...picked(), end({ node: "N27", result: "fail", cause: "arch_wrong" })])).toEqual({ kind: "human", node: "N27", reason: "arch_wrong" });
  });

  it("test_flaky는 N22에서 고친 뒤 N26으로 바로 (then)", () => {
    const ev = [...picked(), end({ node: "N26", result: "fail", cause: "test_flaky" })];
    expect(next(ev)).toEqual({ kind: "node", node: "N22" });
    expect(next([...ev, end({ node: "N22", result: "fail" }), end({ node: "N22", result: "pass" })])).toEqual({ kind: "node", node: "N26" });
  });

  it("code_bug로 N23에 가면 then 없이 순서대로", () => {
    const ev = [...picked(), end({ node: "N26", result: "fail", cause: "code_bug" }), end({ node: "N23", result: "pass" })];
    expect(next(ev)).toEqual({ kind: "node", node: "N24" });
  });

  it("사람을 기다리는 중이면 사람", () => {
    const ev = [...picked(), end({ node: "N26", result: "fail", cause: "spec_ambiguous" }), classify("N26", "spec_ambiguous", true)];
    expect(next(ev)).toEqual({ kind: "human", node: "N26", reason: "spec_ambiguous" });
  });

  it("사람 승인 뒤: 스펙 원인은 원래 작업의 N22로, 횟수 초과는 다시 시도", () => {
    const spec = [...picked(), end({ node: "N26", result: "fail", cause: "spec_ambiguous" }), classify("N26", "spec_ambiguous", true)];
    expect(next([...spec, human("approve", { reason: "spec_ambiguous" })])).toEqual({ kind: "node", node: "N22" });
    const budget = [...picked(), end({ node: "N26", result: "fail", cause: "code_bug" }), classify("N26", "budget_exceeded", true)];
    expect(next([...budget, human("approve", { reason: "budget_exceeded" })])).toEqual({ kind: "node", node: "N23" });
  });

  it("힌트는 다시 시도: 판단 노드면 고치러 가는 노드로", () => {
    const ev = [...picked(), end({ node: "N26", result: "fail", cause: "code_bug" }), classify("N26", "budget_exceeded", true), human("hint")];
    expect(next(ev)).toEqual({ kind: "node", node: "N23" });
    const work = [...picked(), end({ node: "N24", result: "fail" }), classify("N24", "budget_exceeded", true), human("hint")];
    expect(next(work)).toEqual({ kind: "node", node: "N24" });
  });

  it("분류 바로잡기는 새 원인의 경로로, 보류는 다음 작업", () => {
    const ev = [...picked(), end({ node: "N26", result: "fail", cause: "code_bug" }), classify("N26", "budget_exceeded", true)];
    expect(next([...ev, human("reclassify", { cause: "test_flaky" })])).toEqual({ kind: "node", node: "N22" });
    expect(next([...ev, human("reclassify", { cause: "spec_missing_state" })])).toEqual({ kind: "human", node: "N26", reason: "spec_missing_state" });
    expect(next([...ev, human("hold")])).toEqual({ kind: "pick" });
  });
});

describe("이미 충족", () => {
  it("N22가 이미 충족으로 통과하면 N26으로 바로 간다", () => {
    const ev = [...picked(), ev22()];
    expect(next(ev)).toEqual({ kind: "node", node: "N26" });
  });
});

function ev22(): LedgerEvent {
  return { ...base, type: "node_end", id: `NR${++n}`, node: "N22", task: "T1", result: "pass", already_met: true, loaded: [], minutes: 0 } as LedgerEvent;
}

describe("하네스가 정한 갈 곳", () => {
  it("실패한 판단 노드에 next가 있으면 원인 경로 대신 그리로", () => {
    const ev = [...picked(), { ...base, type: "node_end", id: `NR${++n}`, node: "N27", task: "T1", result: "fail", cause: "code_bug", next: "N22", loaded: [], minutes: 0 } as LedgerEvent];
    expect(next(ev)).toEqual({ kind: "node", node: "N22" });
  });
});
