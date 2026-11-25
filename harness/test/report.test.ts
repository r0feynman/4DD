import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { buildReport, renderReport } from "../src/report.ts";

const nodes = loadNodes();
const base = { ts: "2026-11-25T00:00:00.000Z", schema_version: 1 as const, harness: "0.1.0" };
const ev = (e: Record<string, unknown>) => ({ ...base, ...e }) as LedgerEvent;
let k = 0;
function node(task: string, nodeId: string, result: "pass" | "fail", extra: Record<string, unknown> = {}): LedgerEvent[] {
  const id = `NR${++k}`;
  return [
    ev({ type: "node_start", id, node: nodeId, task, session: null }),
    ev({ type: "node_end", id, node: nodeId, task, result, loaded: [{ kind: "instruction", id: nodeId, hash: "h1" }], minutes: 1, tokens: { input: 100, output: 10, cached: 50 }, cost_usd: 0.1, ...extra }),
  ];
}

const events: LedgerEvent[] = [
  ev({ type: "run_start", run: "RUN1", agent: "claude", feature: "login" }),
  ...node("T1", "N22", "pass"),
  ...node("T1", "N26", "fail", { cause: "code_bug" }),
  ...node("T1", "N23", "pass"),
  ...node("T1", "N26", "pass"),
  ...node("T1", "N27", "pass"),
  ...node("T1", "N28", "pass"),
  ...node("T1", "N29", "pass", { task_done: true }),
  ev({ type: "run_start", run: "RUN2", agent: "codex", feature: "login" }),
  ...node("T2", "N24", "fail"),
  ev({ type: "hook_run", id: "HR1", hook: "codex.pre_tool", check: "path", run: `NR${k}`, target: "tests/unit/a.test.ts", result: "blocked" }),
  ev({ type: "hook_run", id: "HR2", hook: "codex.pre_tool", check: "path", run: `NR${k}`, target: "tests/unit/b.test.ts", result: "blocked" }),
  ...node("T2", "N24", "fail"),
  ev({ type: "human", id: "HU1", node: "N24", task: "T2", kind: "hint", reason: "budget_exceeded" }),
  ...node("T2", "N26", "pass"),
];

describe("4dd report", () => {
  const r = buildReport(events, nodes);

  it("다섯 지표: 사람 개입, 첫 통과율, 되돌림, 토큰과 시간", () => {
    expect(r.totals.humansPerTask).toBe(0.5);
    // 판단 노드 첫 통과: T1은 N26 실패·N27 통과·N28 통과 (2/3), T2는 N26 통과 (1/1)
    expect(r.totals.firstPassRate).toBe(0.75);
    expect(r.totals.backtracksPerTask).toBe(1.5);
    expect(r.tasks.find((t) => t.task === "T1")).toMatchObject({ done: true, humans: 0, firstPass: 2, decisions: 3, backtracks: { code_bug: 1 }, minutes: 7 });
    expect(r.tasks.find((t) => t.task === "T2")).toMatchObject({ done: false, humans: 1, backtracks: { "관문 미충족": 2 } });
  });

  it("반복 실수와 비효율 질의", () => {
    expect(r.repeatedHookBlocks).toEqual([{ node: "N24", check: "path", count: 2 }]);
    expect(r.repeatedCauses).toEqual([{ node: "N24", cause: "관문 미충족", count: 2 }]);
    expect(r.pingPong).toEqual([{ from: "N26", to: "N23", count: 1 }]);
    expect(r.humanByNode).toEqual([{ node: "N24", count: 1 }]);
    expect(r.byAgent.map((a) => a.agent)).toEqual(["claude", "codex"]);
    expect(r.instructionVersions.find((v) => v.node === "N24")).toEqual({ node: "N24", hash: "h1", runs: 2, firstTry: 0 });
  });

  it("한국어 보고서로 쓴다", () => {
    const text = renderReport(r);
    expect(text).toContain("| 작업당 사람 개입 수 | 0.5 | 줄어듦 (가장 중요) |");
    expect(text).toContain("N24 · path 2번");
    expect(text).toContain("N26 → N23 1번");
  });

  it("원장이 비어도 보고서를 만든다", () => {
    const empty = buildReport([], nodes);
    expect(empty.totals.firstPassRate).toBeNull();
    expect(renderReport(empty)).toContain("| 첫 통과율 (판단 노드) | - |");
  });
});
