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

describe("4dd report: 화면 기능 (조각 3)", () => {
  const gr = (id: string, run: string, task: string, extra: Record<string, unknown>) =>
    ev({ type: "gate_run", id, node: "N26F", task, run, exit: extra.result === "fail" ? 1 : 0, result: "pass", ...extra });
  const screenEvents: LedgerEvent[] = [
    ev({ type: "run_start", run: "RUN1", agent: "claude", feature: "login-screen" }),
    ev({ type: "device", action: "up", avd: "4dd-api36", result: "ok", boot_seconds: 31 }),
    ...node("T10", "N03F", "pass", { figma_calls: { read: 12, write: 5 } }),
    ev({ type: "gate_run", id: "GR1", node: "N26", task: "T10", run: "NR90", exit: 0, result: "pass", platform: "android", build: true, seconds: 200 }),
    ev({ type: "gate_run", id: "GR2", node: "N26", task: "T10", run: "NR90", exit: 0, result: "pass", platform: "android", seconds: 9.5 }),
    ev({ type: "gate_run", id: "GR3", node: "N26", task: "T10", run: "NR90", exit: 0, result: "pass", platform: "web", seconds: 2.5 }),
    // T10 첫 N26F: android 넘음, web 통과 → 고친 뒤 둘 다 통과
    gr("GR4", "NR91", "T10", { platform: "android", scenario: "S15", diff_percent: 7.2, tolerance: 5, result: "fail" }),
    gr("GR5", "NR91", "T10", { platform: "web", scenario: "S15", diff_percent: 1.4, tolerance: 5 }),
    ...node("T10", "N26F", "fail", { cause: "ui_mismatch" }),
    gr("GR6", "NR92", "T10", { platform: "android", scenario: "S15", diff_percent: 3.1, tolerance: 5 }),
    gr("GR7", "NR92", "T10", { platform: "web", scenario: "S15", diff_percent: 0.6, tolerance: 5 }),
    // T11: 첫 차례에 둘 다 통과
    gr("GR8", "NR93", "T11", { platform: "android", scenario: "S16", diff_percent: 2.2, tolerance: 5 }),
    gr("GR9", "NR93", "T11", { platform: "web", scenario: "S16", diff_percent: 0.9, tolerance: 5 }),
    ...node("T11", "N26F", "fail", { cause: "design_wrong" }),
  ];
  const sc = buildReport(screenEvents, nodes).screens!;

  it("플랫폼별 N26F 첫 통과와 ui_mismatch, 디자인 되돌림", () => {
    expect(sc.firstPass).toEqual([
      { platform: "android", tasks: 2, passed: 1 },
      { platform: "web", tasks: 2, passed: 2 },
    ]);
    expect(sc.uiMismatch).toBe(1);
    expect(sc.designReturns).toEqual({ design_wrong: 1 });
  });

  it("차이 비율 분포, Figma 호출, 기기·빌드·플로우 시간", () => {
    expect(sc.diffs.find((d) => d.platform === "android")).toMatchObject({ count: 3, min: 2.2, median: 3.1, max: 7.2, over: 1, buckets: { "2~5%": 2, "5~10%": 1 } });
    expect(sc.diffs.find((d) => d.platform === "web")).toMatchObject({ count: 3, max: 1.4, buckets: { "1% 이하": 2, "1~2%": 1 } });
    expect(sc.figmaByNode).toEqual([{ node: "N03F", read: 12, write: 5 }]);
    expect(sc.boots).toEqual([31]);
    expect(sc.builds).toEqual([{ platform: "android", count: 1, avgSeconds: 200, maxSeconds: 200 }]);
    expect(sc.flows.map((f) => `${f.platform}:${f.avgSeconds}`)).toEqual(["android:9.5", "web:2.5"]);
    const text = renderReport(buildReport(screenEvents, nodes));
    expect(text).toContain("## 화면 기능 (조각 3)");
    expect(text).toContain("N26F 첫 통과: android 1/2, web 2/2 · ui_mismatch로 N24에 보냄 1번");
    expect(text).toContain("| android | 3 | 2.2% | 3.1% | 7.2% | 1 | 0 | 0 | 2 | 1 | 0 |");
  });

  it("화면 기록이 없으면 그 칸을 쓰지 않는다", () => {
    expect(buildReport(events, nodes).screens).toBeNull();
    expect(renderReport(buildReport(events, nodes))).not.toContain("화면 기능 (조각 3)");
  });
});
