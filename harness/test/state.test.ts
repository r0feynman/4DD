import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, readEvents, type NewEvent } from "../src/ledger.ts";
import { initialState, loadState, rebuildState, statePath, writeState } from "../src/state.ts";

const H = "0.1.0";
const project = () => mkdtempSync(join(tmpdir(), "4dd-state-"));
const write = (root: string, events: NewEvent[]) => events.forEach((e) => appendEvent(root, H, e));

/** T1을 N21부터 N26까지 진행하다 N26에서 code_bug로 한 번 실패한 원장 */
const T1_FAIL_AT_N26: NewEvent[] = [
  { type: "run_start", run: "RUN1", agent: "claude", feature: "login" },
  { type: "node_start", id: "NR1", node: "N21", task: null, session: null },
  { type: "node_end", id: "NR1", node: "N21", task: "T1", result: "pass", minutes: 0 },
  { type: "node_start", id: "NR2", node: "N22", task: "T1", session: "sess-a" },
  { type: "gate_run", id: "GR1", node: "N22", task: "T1", run: "NR2", exit: 1, result: "pass" },
  { type: "node_end", id: "NR2", node: "N22", task: "T1", result: "pass", minutes: 3 },
  { type: "node_start", id: "NR3", node: "N26", task: "T1", session: null },
  { type: "gate_run", id: "GR2", node: "N26", task: "T1", run: "NR3", exit: 1, result: "fail" },
  { type: "classify", run: "NR3", node: "N26", cause: "code_bug", by: "harness", needs_human: false },
  { type: "node_end", id: "NR3", node: "N26", task: "T1", result: "fail", cause: "code_bug", minutes: 1 },
];

describe("리뷰 세션은 작업 세션이 아니다 (2026-11-27 Codex 실제 실행)", () => {
  const base: NewEvent[] = [
    { type: "run_start", run: "RUN1", agent: "codex", feature: "login" },
    { type: "node_start", id: "NR2", node: "N22", task: "T1", session: null },
    { type: "node_end", id: "NR2", node: "N22", task: "T1", result: "pass", session: "work", minutes: 1 },
  ];
  it("새 기록: N27의 review_session은 작업 세션을 바꾸지 않는다", () => {
    const root = project();
    write(root, [...base, { type: "node_end", id: "NR3", node: "N27", task: "T1", result: "fail", review_session: "review-1", minutes: 1 }]);
    expect(rebuildState(readEvents(root).events)).toMatchObject({ session: "work", review_sessions: ["review-1"] });
  });

  it("예전 원장: N27의 session과, 그 세션을 이어 쓴 뒤 노드의 session을 건너뛰어 작업 세션으로 돌아간다", () => {
    const root = project();
    write(root, [
      ...base,
      { type: "node_end", id: "NR3", node: "N27", task: "T1", result: "fail", session: "review-1", minutes: 1 },
      { type: "node_end", id: "NR4", node: "N23", task: "T1", result: "fail", session: "review-1", minutes: 1 },
    ]);
    expect(rebuildState(readEvents(root).events).session).toBe("work");
  });
});

describe("원장에서 상태 만들기", () => {
  it("처음 상태", () => {
    expect(initialState()).toMatchObject({ status: "idle", task: null, node: null, events: 0 });
  });

  it("작업, 노드, 세션, 실패 수, 마지막 실패 관문을 접는다", () => {
    const root = project();
    write(root, T1_FAIL_AT_N26);
    const s = rebuildState(readEvents(root).events);
    expect(s).toMatchObject({
      status: "running",
      run: "RUN1",
      agent: "claude",
      feature: "login",
      task: "T1",
      node: "N26",
      node_run: "NR3",
      session: "sess-a",
      fails: { N22: 0, N26: 1 },
      task_backtracks: 1,
      last_gate: "GR2",
      events: T1_FAIL_AT_N26.length,
    });
  });

  it("사람이 필요한 원인이면 기다리고, 사람이 승인하면 횟수를 새로 준다", () => {
    const root = project();
    write(root, [
      ...T1_FAIL_AT_N26,
      { type: "node_start", id: "NR4", node: "N26", task: "T1", session: null },
      { type: "node_end", id: "NR4", node: "N26", task: "T1", result: "fail", cause: "spec_ambiguous", minutes: 1 },
      { type: "classify", run: "NR4", node: "N26", cause: "spec_ambiguous", by: "agent", needs_human: true },
      { type: "run_end", run: "RUN1", reason: "wait_human" },
    ]);
    let s = rebuildState(readEvents(root).events);
    expect(s.status).toBe("waiting_human");
    expect(s.waiting).toEqual({ node: "N26", task: "T1", reason: "spec_ambiguous" });
    expect(s.fails.N26).toBe(2);
    expect(s.task_backtracks).toBe(2);

    appendEvent(root, H, { type: "human", id: "HU1", node: "N26", task: "T1", kind: "approve", reason: "spec_ambiguous", minutes: 4 });
    s = rebuildState(readEvents(root).events);
    expect(s.status).toBe("running");
    expect(s.waiting).toBeNull();
    expect(s.fails.N26).toBe(0);
    expect(s.task_backtracks).toBe(0);
  });

  it("작업을 끝내면 작업 단위 값을 비우고, 다음 작업은 새로 센다", () => {
    const root = project();
    write(root, [
      ...T1_FAIL_AT_N26,
      { type: "node_start", id: "NR5", node: "N29", task: "T1", session: null },
      { type: "node_end", id: "NR5", node: "N29", task: "T1", result: "pass", task_done: true, minutes: 0 },
      { type: "node_start", id: "NR6", node: "N21", task: null, session: null },
      { type: "node_end", id: "NR6", node: "N21", task: "T2", result: "pass", minutes: 0 },
    ]);
    const s = rebuildState(readEvents(root).events);
    expect(s.done_tasks).toEqual(["T1"]);
    expect(s).toMatchObject({ task: "T2", session: null, fails: {}, task_backtracks: 0, last_gate: null });
  });

  it("보류하면 작업을 내려놓고 멈춘다", () => {
    const root = project();
    write(root, [...T1_FAIL_AT_N26, { type: "human", id: "HU1", node: "N26", task: "T1", kind: "hold" }]);
    const s = rebuildState(readEvents(root).events);
    expect(s).toMatchObject({ status: "idle", task: null, node: null, held_tasks: ["T1"] });
  });
});

describe("state.json 저장과 다시 만들기", () => {
  it("저장한 상태를 그대로 읽는다", () => {
    const root = project();
    write(root, T1_FAIL_AT_N26);
    writeState(root, rebuildState(readEvents(root).events));
    const r = loadState(root);
    expect(r.rebuilt).toBe(false);
    expect(r.state.node).toBe("N26");
    expect(existsSync(statePath(root) + ".tmp")).toBe(false);
  });

  it("state.json이 없으면 원장에서 다시 만들어 저장한다", () => {
    const root = project();
    write(root, T1_FAIL_AT_N26);
    const r = loadState(root);
    expect(r.rebuilt).toBe(true);
    expect(JSON.parse(readFileSync(statePath(root), "utf8")).node).toBe("N26");
  });

  it("원장이 state.json보다 길면(저장 전에 죽음) 다시 만든다", () => {
    const root = project();
    write(root, T1_FAIL_AT_N26);
    writeState(root, rebuildState(readEvents(root).events));
    appendEvent(root, H, { type: "node_start", id: "NR4", node: "N23", task: "T1", session: null });
    const r = loadState(root);
    expect(r.rebuilt).toBe(true);
    expect(r.state.node).toBe("N23");
  });

  it("깨진 state.json도 원장에서 다시 만든다", () => {
    const root = project();
    write(root, T1_FAIL_AT_N26);
    writeFileSync(statePath(root), "{깨짐");
    expect(loadState(root).state.node).toBe("N26");
    unlinkSync(statePath(root));
  });

  it("원장이 없으면 처음 상태이고 파일을 만들지 않는다", () => {
    const root = project();
    const r = loadState(root);
    expect(r.state).toEqual(initialState());
    expect(existsSync(statePath(root))).toBe(false);
  });
});
