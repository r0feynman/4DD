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

  it("사람 승인 뒤: 스펙 원인은 스펙(N02)부터 고치고 N04 승인 뒤 원래 작업의 N22로, 횟수 초과는 다시 시도", () => {
    const spec = [...picked(), end({ node: "N26", result: "fail", cause: "spec_ambiguous" }), classify("N26", "spec_ambiguous", true)];
    const ok = [...spec, human("approve", { reason: "spec_ambiguous" })];
    expect(next(ok)).toEqual({ kind: "node", node: "N02" });
    expect(next([...ok, end({ node: "N02", result: "pass" })])).toEqual({ kind: "node", node: "N03" });
    expect(next([...ok, end({ node: "N02", result: "pass" }), end({ node: "N03", result: "pass" })])).toEqual({ kind: "node", node: "N04" });
    const atN04 = [...ok, end({ node: "N02", result: "pass" }), end({ node: "N03", result: "pass" }), end({ node: "N04", result: "wait" })];
    expect(next(atN04)).toEqual({ kind: "human", node: "N04", reason: "review" });
    expect(next([...atN04, human("approve", { node: "N04", review: "RV1" })])).toEqual({ kind: "node", node: "N22" });
    const budget = [...picked(), end({ node: "N26", result: "fail", cause: "code_bug" }), classify("N26", "budget_exceeded", true)];
    expect(next([...budget, human("approve", { reason: "budget_exceeded" })])).toEqual({ kind: "node", node: "N23" });
  });

  it("사람이 approve --to로 이어 갈 노드를 정하면 같은 노드를 다시 하지 않고 그 노드로 (2026-11-27 실제 실행)", () => {
    // 리뷰가 단위 테스트만 요구했는데 N23이 「처음엔 실패」를 못 채워 횟수 제한에 걸림
    const stuck = [...picked(), end({ node: "N23", result: "fail" }), classify("N23", "budget_exceeded", true)];
    expect(next([...stuck, human("approve", { node: "N23", reason: "budget_exceeded" })])).toEqual({ kind: "node", node: "N23" });
    expect(next([...stuck, human("approve", { node: "N23", reason: "budget_exceeded", to: "N27" })])).toEqual({ kind: "node", node: "N27" });
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

  it("작업 노드(N24)가 횟수 제한을 넘었을 때 스펙 원인으로 바로잡으면, 사람 승인 뒤 스펙부터 고치고 원래 작업의 N22로", () => {
    // 2026-11-26 오너가 PO인 실제 실행: 아이디 규칙(4~20자)과 예시 아이디 lee(3자)가 부딪쳐 N24가 3번 실패
    const stuck = [...picked(), end({ node: "N24", result: "fail" }), end({ node: "N24", result: "fail" }), end({ node: "N24", result: "fail" }), classify("N24", "budget_exceeded", true)];
    const atN24 = (kind: string, extra: Record<string, unknown> = {}) => human(kind, { node: "N24", ...extra });
    // 같은 스테이지 원인(code_bug)이면 지금처럼 같은 노드를 다시
    expect(next([...stuck, atN24("reclassify", { cause: "code_bug" })])).toEqual({ kind: "node", node: "N24" });
    // 스펙 원인이면 사람(PO)의 승인을 기다린다
    const re = [...stuck, atN24("reclassify", { cause: "spec_ambiguous" })];
    expect(next(re)).toEqual({ kind: "human", node: "N24", reason: "spec_ambiguous" });
    const ok = [...re, atN24("approve", { reason: "spec_ambiguous" })];
    expect(next(ok)).toEqual({ kind: "node", node: "N02" });
    const atN04 = [...ok, end({ node: "N02", result: "pass" }), end({ node: "N03", result: "pass" }), end({ node: "N04", result: "wait" })];
    expect(next(atN04)).toEqual({ kind: "human", node: "N04", reason: "review" });
    expect(next([...atN04, human("approve", { node: "N04", review: "RV1" })])).toEqual({ kind: "node", node: "N22" });
    // 설계 원인이면 N27의 경로: 승인 뒤 N13부터
    const arch = [...stuck, atN24("reclassify", { cause: "arch_wrong" })];
    expect(next(arch)).toEqual({ kind: "human", node: "N24", reason: "arch_wrong" });
    expect(next([...arch, atN24("approve", { reason: "arch_wrong" })])).toEqual({ kind: "node", node: "N13" });
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

describe("화면 기능의 Stage 0 (조각 3)", () => {
  let k = 1000;
  const planEnd = (node: string, feature = "login-screen", extra: Record<string, unknown> = {}): LedgerEvent[] => {
    k++;
    return [
      { ...base, type: "node_start", id: `NR${k}`, node, task: null, feature, session: null } as LedgerEvent,
      { ...base, type: "node_end", id: `NR${k}`, node, task: null, feature, result: "pass", loaded: [], minutes: 0, ...extra } as LedgerEvent,
    ];
  };
  const go = (events: LedgerEvent[], type: "mobile" | "backend") => decideNext(events, nodes, type, rebuildState(events));

  it("화면 기능은 N03 뒤 디자인 시스템(처음 한 번) → 와이어프레임 → 완성 화면 → N04, 백엔드는 바로 N04", () => {
    const n03 = [...planEnd("N01"), ...planEnd("N02"), ...planEnd("N03")];
    expect(go(n03, "backend")).toEqual({ kind: "node", node: "N04" });
    expect(go(n03, "mobile")).toEqual({ kind: "node", node: "N00F" });
    expect(go([...n03, ...planEnd("N00F")], "mobile")).toEqual({ kind: "node", node: "N03W" });
    expect(go([...n03, ...planEnd("N00F"), ...planEnd("N03W")], "mobile")).toEqual({ kind: "node", node: "N03F" });
    expect(go([...n03, ...planEnd("N00F"), ...planEnd("N03W"), ...planEnd("N03F")], "mobile")).toEqual({ kind: "node", node: "N04" });
  });

  it("디자인 시스템은 프로젝트에 한 번: 앞 기능에서 통과했으면 다음 화면 기능은 와이어프레임으로", () => {
    const first = [...planEnd("N00F", "login-screen")];
    const second = [...first, ...planEnd("N01", "signup-screen"), ...planEnd("N02", "signup-screen"), ...planEnd("N03", "signup-screen")];
    expect(go(second, "mobile")).toEqual({ kind: "node", node: "N03W" });
  });
});

describe("물을 것이 남으면 디자인 전에 묻기 (조각 3)", () => {
  it("hold가 디자인 노드를 막으면 N03 뒤 바로 N04", () => {
    const base2 = { ts: "2026-11-27T00:00:00.000Z", schema_version: 1 as const, harness: "0.3.0" };
    const ev: LedgerEvent[] = ["N01", "N02", "N03"].flatMap((node, i) => [
      { ...base2, type: "node_start", id: `NR${900 + i}`, node, task: null, feature: "f", session: null } as LedgerEvent,
      { ...base2, type: "node_end", id: `NR${900 + i}`, node, task: null, feature: "f", result: "pass", loaded: [], minutes: 0 } as LedgerEvent,
    ]);
    const design = (n: string) => nodes.nodes[n]?.method === "figma" && nodes.nodes[n]?.stage === 0;
    expect(decideNext(ev, nodes, "mobile", rebuildState(ev), design)).toEqual({ kind: "node", node: "N04" });
    expect(decideNext(ev, nodes, "mobile", rebuildState(ev))).toEqual({ kind: "node", node: "N00F" });
  });
});
