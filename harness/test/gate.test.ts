// 실제 프로젝트(4dd init)에서 Vitest를 돌려, 노드마다 관문이 통과·실패를 맞게 판정하는지 본다.
// 시험 프로젝트의 의존 패키지 대신 하네스의 node_modules(vitest가 있음)를 연결해 빠르게 돈다.
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { runGate, taskScenarios } from "../src/gate.ts";
import { git } from "../src/git.ts";
import { initProject } from "../src/init.ts";
import { appendEvent, readEvents } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";

const harnessModules = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
const nodes = loadNodes();
const H = nodes.version;
let root = "";
let config: Config;
let initSha = "";

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** 하네스가 노드를 통과시키고 커밋하는 것처럼 (잠금 검사는 3단계에서 따로 시험했으므로 여기서는 풀고 커밋) */
const commitAll = (msg: string) => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", msg], { FOURDD_ALLOW_LOCKED: "1" });
  return git(root, ["rev-parse", "HEAD"]).trim();
};
const gate = (nodeId: string, task: string | null = "T1", cfg: Config = config) => runGate({ root, config: cfg, nodes, nodeId, task, runId: "NR1" });

const FAILING_S1 = `import { test, expect } from "vitest";\nimport { add } from "../../src/math.ts";\ntest("S1 로그인", () => { expect(add(1, 1)).toBe(2); });\n`;
const FAILING_UNIT = `import { test, expect } from "vitest";\nimport { add } from "../../src/math.ts";\ntest("add", () => { expect(add(2, 3)).toBe(5); });\n`;

beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-gate-")), "proj");
  initProject(root, { install: false });
  symlinkSync(harnessModules, join(root, "node_modules"), "dir");
  config = loadConfig(root);
  initSha = git(root, ["rev-parse", "HEAD"]).trim();
  // N21이 T1을 고르고 커밋했다고 원장에 남긴다 (작업 시작 커밋)
  appendEvent(root, H, { type: "commit", sha: initSha, node: "N21", task: "T1" });
});

describe("작업의 시나리오", () => {
  it("T1은 S1, 파일이 없으면 정해진 이름", () => {
    expect(taskScenarios(root, "T1")).toEqual({ ids: ["S1"], files: ["tests/acceptance/S1.test.ts"] });
    expect(taskScenarios(root, "T9")).toEqual({ ids: [], files: [] });
  });
});

describe("노드별 관문", () => {
  it("N22: 인수 테스트가 없으면 실패", () => {
    const r = gate("N22");
    expect(r.passed).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: "scenario_files_exist", ok: false });
    expect(r.summary).toContain("@S1");
  });

  it("N22: 시나리오의 인수 테스트가 있고 실패하면 통과", () => {
    put("tests/acceptance/S1.test.ts", FAILING_S1);
    const r = gate("N22");
    expect(r.summary).toBe("N22 관문 통과");
    expect(r.runs[0]).toMatchObject({ result: "pass" });
    expect(r.runs[0].exit).not.toBe(0);
    commitAll("N22");
  });

  it("N23: 새 단위 테스트가 없으면 실패, 실패하는 새 테스트를 쓰면 통과", () => {
    expect(gate("N23").checks[0]).toMatchObject({ name: "new_tests", ok: false });
    put("tests/unit/math.test.ts", FAILING_UNIT);
    const r = gate("N23");
    expect(r.passed).toBe(true);
    expect(r.checks[0].detail).toContain("0개에서 1개로");
    commitAll("N23");
  });

  it("N24: 단위 테스트가 실패하면 실패, 구현하면 통과", () => {
    const fail = gate("N24");
    expect(fail.passed).toBe(false);
    expect(fail.summary).toContain("통과해야 하는데 실패했습니다");
    put("src/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    expect(gate("N24").passed).toBe(true);
    commitAll("N24");
  });

  it("N25: 테스트가 줄면 실패", () => {
    expect(gate("N25").passed).toBe(true);
    rmSync(join(root, "tests/unit/math.test.ts"));
    const r = gate("N25");
    expect(r.checks.find((c) => c.name === "test_count_kept")).toMatchObject({ ok: false });
    git(root, ["checkout", "--", "tests/unit/math.test.ts"]);
  });

  it("N23: 스펙을 고치러 갔다 다시 승인받고 돌아온 작업이면, 기존 단위 테스트를 새 스펙에 맞게 고친 것도 받는다", () => {
    // 2026-11-26 실제 실행: 아이디 예시가 lee → lee01로 바뀌었는데 앞 작업의 단위 테스트가 lee를 써서 N23이 3번 막힘
    expect(gate("N23").passed).toBe(false); // 구현이 있어 통과하고 새 테스트도 없다
    appendEvent(root, H, { type: "human", id: "HU90", node: "N04", task: "T1", kind: "approve", review: "RV9" });
    const untouched = gate("N23");
    expect(untouched.runs.every((r) => r.result === "pass")).toBe(true); // 실패를 요구하지 않는다
    expect(untouched.checks.find((c) => c.name === "new_tests")).toMatchObject({ ok: false }); // 그래도 아무것도 안 고치면 안 된다
    put("tests/unit/math.test.ts", FAILING_UNIT.replace("add(2, 3)).toBe(5)", "add(2, 2)).toBe(4)"));
    const fixed = gate("N23");
    expect(fixed.passed).toBe(true);
    expect(fixed.checks.find((c) => c.name === "new_tests")?.detail).toContain("기존 단위 테스트를 새 스펙에 맞게");
    git(root, ["checkout", "--", "tests/unit/math.test.ts"]);
  });

  it("N26: 인수 테스트가 통과하면 통과", () => {
    expect(gate("N26").passed).toBe(true);
  });

  it("N26: 계속 실패하면 원인은 분류 차례로 (기계가 정하지 않음)", () => {
    put("src/math.ts", "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    const r = gate("N26");
    expect(r.passed).toBe(false);
    expect(r.cause).toBeUndefined();
    expect(r.runs.map((x) => x.flakyRerun)).toEqual([false, true]);
    git(root, ["checkout", "--", "src/math.ts"]);
  });

  it("N26: 다시 돌렸더니 통과하면 test_flaky", () => {
    const counter = join(root, ".flaky-count");
    put(
      "tests/acceptance/S1.test.ts",
      `import { test, expect } from "vitest";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("S1 불안정", () => {\n  const first = !existsSync(${JSON.stringify(counter)});\n  writeFileSync(${JSON.stringify(counter)}, "1");\n  expect(first).toBe(false);\n});\n`,
    );
    const r = gate("N26");
    expect(r).toMatchObject({ passed: false, cause: "test_flaky" });
    expect(r.summary).toContain("test_flaky");
    git(root, ["checkout", "--", "tests/acceptance/S1.test.ts"]);
    rmSync(counter, { force: true });
  });

  it("N26: 명령을 실행하지 못하면 env", () => {
    const broken = { ...config, commands: { ...config.commands, run_files: "no-such-command-4dd" } };
    expect(gate("N26", "T1", broken)).toMatchObject({ passed: false, cause: "env" });
  });

  it("N28: TDD 순서가 원장에 없으면 실패, 있으면 통과", () => {
    const before = gate("N28");
    expect(before.checks.find((c) => c.name === "tdd_order")).toMatchObject({ ok: false });
    appendEvent(root, H, { type: "node_end", id: "NR3", node: "N23", task: "T1", result: "pass", minutes: 1 });
    appendEvent(root, H, { type: "node_end", id: "NR4", node: "N24", task: "T1", result: "pass", minutes: 1 });
    const after = gate("N28");
    expect(after.checks.map((c) => [c.name, c.ok])).toEqual([
      ["tdd_order", true],
      ["test_count_kept", true],
      ["no_new_skips", true],
      ["locked_unchanged", true],
    ]);
    expect(after.passed).toBe(true);
  });

  it("N28: N24가 막혀 사람이 구현을 확인하고 approve --to로 넘겼으면 TDD 순서로 친다 (2026-11-27 실제 실행)", () => {
    // 앞 묶음이 T1의 통과 기록을 남겼으므로 다른 작업(T2)으로 본다
    const t2 = () => gate("N28", "T2").checks.find((c) => c.name === "tdd_order");
    appendEvent(root, H, { type: "node_end", id: "NR13", node: "N23", task: "T2", result: "pass", minutes: 1 });
    appendEvent(root, H, { type: "node_end", id: "NR14", node: "N24", task: "T2", result: "fail", minutes: 1 });
    expect(t2()).toMatchObject({ ok: false });
    appendEvent(root, H, { type: "human", id: "HU1", node: "N24", task: "T2", kind: "approve", reason: "budget_exceeded", to: "N25", by: "dev" });
    expect(t2()).toMatchObject({ ok: true, detail: expect.stringContaining("사람이 N24의 구현을 확인") });
  });

  it("N28: 건너뛰기 표시가 새로 생기면 실패", () => {
    appendFileSync(join(root, "tests/unit/math.test.ts"), `test.skip("나중에", () => {});\n`);
    expect(gate("N28").checks.find((c) => c.name === "no_new_skips")).toMatchObject({ ok: false });
    git(root, ["checkout", "--", "tests/unit/math.test.ts"]);
  });

  it("N28: 잠긴 파일이 기준 해시와 다르면 실패", () => {
    appendFileSync(join(root, "specs/login/spec.md"), "\n바뀜\n");
    const r = gate("N28");
    expect(r.checks.find((c) => c.name === "locked_unchanged")).toMatchObject({ ok: false });
    expect(r.summary).toContain("specs/login/spec.md");
    git(root, ["checkout", "--", "specs/login/spec.md"]);
  });

  it("시나리오가 없는 작업은 시나리오 관문을 건너뛴다", () => {
    const fixtureWithNoScenario = { ...config };
    expect(gate("N26", "T9", fixtureWithNoScenario)).toMatchObject({ passed: true, runs: [] });
  });
});

describe("관문 실행 기록", () => {
  it("명령마다 원장에 남기고, 출력은 .4dd/gates/에 둔다", () => {
    const runs = readEvents(root).events.filter((e) => e.type === "gate_run");
    expect(runs.length).toBeGreaterThan(10);
    const ids = runs.map((e) => (e.type === "gate_run" ? e.id : ""));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(existsSync(join(root, ".4dd/gates", `${id}.log`)), id).toBe(true);
    const withTests = runs.find((e) => e.type === "gate_run" && e.tests);
    expect(withTests && withTests.type === "gate_run" && withTests.tests?.total).toBeGreaterThan(0);
    expect(runs.some((e) => e.type === "gate_run" && e.flaky_rerun)).toBe(true);
  });

  it("관문 출력은 git이 무시한다", () => {
    expect(git(root, ["status", "--porcelain", "--", ".4dd/gates"]).trim()).toBe("");
  });
});

describe("작업의 시나리오만 돌리기", () => {
  it("N22·N26은 run_files로 그 작업의 시나리오 파일만 돌린다 (인수 테스트 전체가 아니라)", () => {
    put("tests/acceptance/S2.test.ts", `import { test, expect } from "vitest";\ntest("S2 다른 작업", () => { expect(1).toBe(2); });\n`);
    const r = gate("N26");
    expect(r.runs[0].command).toBe("npx vitest run tests/acceptance/S1.test.ts");
    expect(r.passed).toBe(true);
    rmSync(join(root, "tests/acceptance/S2.test.ts"));
  });

  it("run_files가 없으면 acceptance로 대신한다", () => {
    const { run_files: _, ...rest } = config.commands;
    const r = gate("N26", "T1", { ...config, commands: rest });
    expect(r.runs[0].command).toBe("npx vitest run tests/acceptance tests/acceptance/S1.test.ts");
  });
});
