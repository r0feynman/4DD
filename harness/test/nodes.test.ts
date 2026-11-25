import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedCauses, budgetFor, failRoute, instructionPath, loadNodes, nextNode, NodesError, parseNodes } from "../src/nodes.ts";

describe("하네스의 nodes.yaml", () => {
  const set = loadNodes();

  it("Stage 2의 노드 아홉 개를 파일 순서대로 읽는다", () => {
    expect(set.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(set.order).toEqual(["N21", "N22", "N23", "N24", "N25", "N26", "N27", "N28", "N29"]);
  });

  it("노드마다 맡는 쪽과 고칠 수 있는 경로가 명세 표와 같다", () => {
    const pick = (id: string) => [set.nodes[id].actor, set.nodes[id].writes];
    expect(pick("N21")).toEqual(["harness", [".4dd/**"]]);
    expect(pick("N22")).toEqual(["worker", ["tests/acceptance/**"]]);
    expect(pick("N23")).toEqual(["worker", ["tests/unit/**"]]);
    expect(pick("N24")).toEqual(["worker", ["src/**"]]);
    expect(pick("N25")).toEqual(["worker", ["src/**"]]);
    expect(pick("N26")).toEqual(["harness", []]);
    expect(pick("N27")).toEqual(["reviewer", []]);
    expect(pick("N28")).toEqual(["harness", []]);
    expect(pick("N29")).toEqual(["harness", ["specs/*/tasks.md"]]);
  });

  it("작업 노드의 관문은 N22·N23이 실패를, N24·N25가 통과를 기대한다", () => {
    expect(["N22", "N23", "N24", "N25"].map((id) => set.nodes[id].gate?.expect)).toEqual(["fail", "fail", "pass", "pass"]);
  });

  it("다음 노드: 파일 순서대로 가고, N29는 N21로 돌아간다", () => {
    expect(nextNode(set, "N21", "backend")).toBe("N22");
    expect(nextNode(set, "N26", "backend")).toBe("N27");
    expect(nextNode(set, "N28", "backend")).toBe("N29");
    expect(nextNode(set, "N29", "backend")).toBe("N21");
  });

  it("실패 원인별로 갈 곳", () => {
    expect(failRoute(set, "N26", "code_bug")).toEqual({ goto: "N23" });
    expect(failRoute(set, "N26", "test_flaky")).toEqual({ goto: "N22", then: "N26" });
    expect(failRoute(set, "N26", "spec_ambiguous")).toEqual({ goto: "human", then: "N22" });
    expect(failRoute(set, "N27", "arch_wrong")).toEqual({ goto: "human", then: "N21" });
    expect(failRoute(set, "N26", "ui_mismatch")).toBeNull();
    expect(allowedCauses(set, "N27")).toEqual(["code_bug", "arch_wrong"]);
  });

  it("횟수 제한은 기본값 3, 작업 전체 10", () => {
    expect(budgetFor(set, "N26")).toBe(3);
    expect(set.defaults.task_budget).toBe(10);
  });

  it("세션이 하는 노드의 지시문 파일이 있다", () => {
    for (const id of ["N22", "N23", "N24", "N25", "N27"]) {
      expect(instructionPath(set, id)).toMatch(new RegExp(`instructions/${id}\\.md$`));
    }
    expect(instructionPath(set, "N26")).toBeNull();
  });
});

describe("잘못된 노드 정의를 잡는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "4dd-nodes-"));
  mkdirSync(join(dir, "instructions"));
  writeFileSync(join(dir, "instructions", "N24.md"), "# N24\n");
  const HEAD = "version: 0.1.0\ndefaults: {budget: 3, task_budget: 10, flaky_retries: 1, turn_timeout_min: 15}\n";
  const WORKER = "N24:\n  name: 구현\n  stage: 2\n  method: tdd\n  kind: work\n  actor: worker\n  instruction: instructions/N24.md\n  writes: [\"src/**\"]\n  gate: {run: \"npm test\", expect: pass}\n";
  const problems = (yaml: string): string[] => {
    try {
      parseNodes(HEAD + yaml, dir);
      return [];
    } catch (e) {
      if (e instanceof NodesError) return e.problems;
      throw e;
    }
  };

  it("올바른 정의는 통과한다", () => {
    expect(problems(WORKER)).toEqual([]);
  });

  it("통제 어휘에 없는 실패 원인", () => {
    const yaml = WORKER + "N26:\n  name: 판단\n  stage: 2\n  method: bdd\n  kind: decision\n  actor: harness\n  gate: {run: x, expect: pass}\n  on_fail:\n    - when: typo_bug\n      goto: N24\n";
    expect(problems(yaml).some((p) => p.startsWith("N26.on_fail.0.when"))).toBe(true);
  });

  it("없는 노드로 가는 경로와 then 없는 사람 경로", () => {
    const yaml = WORKER + "N26:\n  name: 판단\n  stage: 2\n  method: bdd\n  kind: decision\n  actor: harness\n  gate: {run: x, expect: pass}\n  on_fail:\n    - when: code_bug\n      goto: N99\n    - when: env\n      goto: human\n";
    const p = problems(yaml);
    expect(p).toContain("N26: N99는 정의되지 않은 노드입니다");
    expect(p).toContain("N26: 사람에게 가는 경로에는 승인 뒤 갈 곳(then)이 있어야 합니다");
  });

  it("지시문이 없거나 파일이 없는 세션 노드", () => {
    expect(problems(WORKER.replace("  instruction: instructions/N24.md\n", ""))).toContain("N24: 세션이 하는 노드에는 지시문(instruction)이 있어야 합니다");
    expect(problems(WORKER.replace("instructions/N24.md", "instructions/없음.md"))).toContain("N24: 지시문 파일이 없습니다 (instructions/없음.md)");
  });

  it("관문 없는 작업 세션 노드, on_fail 없는 판단 노드", () => {
    expect(problems(WORKER.replace('  gate: {run: "npm test", expect: pass}\n', ""))).toContain("N24: 작업 세션 노드에는 끝났는지 볼 관문(gate)이 있어야 합니다");
    const yaml = WORKER + "N26:\n  name: 판단\n  stage: 2\n  method: bdd\n  kind: decision\n  actor: harness\n  gate: {run: x, expect: pass}\n";
    expect(problems(yaml)).toContain("N26: 판단 노드에는 실패 원인별로 갈 곳(on_fail)이 있어야 합니다");
  });

  it("모르는 키와 틀린 필드 값", () => {
    expect(problems(WORKER + "foo: 1\n")).toContain("foo: 알 수 없는 키입니다 (노드 ID, version, defaults만 씁니다)");
    expect(problems(WORKER.replace("actor: worker", "actor: robot")).some((p) => p.startsWith("N24.actor"))).toBe(true);
    expect(problems(WORKER.replace("  stage: 2\n", "  stage: 2\n  colour: red\n")).some((p) => p.startsWith("N24"))).toBe(true);
  });

  it("버전이 없음", () => {
    try {
      parseNodes(HEAD.replace("version: 0.1.0\n", "") + WORKER, dir);
      expect.unreachable();
    } catch (e) {
      expect((e as NodesError).problems).toContain("version: 0.1.0 꼴의 하네스 버전이 있어야 합니다");
    }
  });
});
