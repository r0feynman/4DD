import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFeatureDir, checkProject, parseFeature, scenariosForTask, type TraceIssue } from "../src/trace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "fixtures", "login-backend");
const template = join(here, "..", "..", "templates", "specs", "example");

const errors = (issues: TraceIssue[]) => issues.filter((i) => i.level === "error");
const warnings = (issues: TraceIssue[]) => issues.filter((i) => i.level === "warning");

function featureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "4dd-trace-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const SPEC = "# 스펙\n- R1 로그인\n- R2 잠금\n";
const FEATURE = "기능: 로그인\n\n  @S1 @R1\n  시나리오: 성공\n    만일 로그인하면\n\n  @S2 @R2\n  시나리오: 잠금\n    만일 틀리면\n";
const TASKS = "- [ ] T1 로그인 API (R1)\n- [ ] T2 잠금 (R2)\n";

describe("시험 프로젝트 (login-backend)", () => {
  const [trace] = checkProject(fixture);

  it("오류와 주의 없이 통과한다", () => {
    expect(trace.issues).toEqual([]);
  });

  it("ID를 모두 읽는다", () => {
    expect(trace.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3"]);
    expect(trace.scenarios.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(trace.tasks.map((t) => [t.id, t.reqs])).toEqual([
      ["T1", ["R1"]],
      ["T2", ["R2"]],
      ["T3", ["R3"]],
    ]);
  });

  it("작업마다 통과시킬 시나리오가 하나씩 정해진다", () => {
    expect(scenariosForTask(trace, "T1").map((s) => s.id)).toEqual(["S1"]);
    expect(scenariosForTask(trace, "T2").map((s) => s.id)).toEqual(["S2"]);
    expect(scenariosForTask(trace, "T3").map((s) => s.id)).toEqual(["S3"]);
  });

  it("시나리오 개요도 시나리오로 읽고, 「예:」는 시나리오로 읽지 않는다", () => {
    expect(trace.scenarios[0].title).toBe("아이디와 비밀번호로 로그인");
    expect(trace.scenarios).toHaveLength(3);
  });
});

describe("저장소 예시 템플릿", () => {
  const trace = checkFeatureDir(template);

  it("오류 없이 통과한다", () => {
    expect(errors(trace.issues)).toEqual([]);
  });

  it("같은 요구사항의 뒤 작업이 시나리오를 맡고, 앞 작업은 주의로 알린다", () => {
    expect(scenariosForTask(trace, "T3").map((s) => s.id)).toEqual(["S1"]);
    expect(scenariosForTask(trace, "T4").map((s) => s.id)).toEqual(["S2"]);
    expect(warnings(trace.issues).map((i) => i.message.slice(0, 2))).toEqual(["T1", "T2"]);
  });
});

describe("잘못된 추적 ID를 잡는다", () => {
  const check = (files: Record<string, string>) => {
    const t = checkFeatureDir(featureDir({ "spec.md": SPEC, "login.feature": FEATURE, "tasks.md": TASKS, ...files }));
    return errors(t.issues).map((i) => i.message);
  };

  it("기본 예는 통과한다", () => {
    expect(check({})).toEqual([]);
  });

  it("시나리오 ID 태그가 없음", () => {
    const msgs = check({ "login.feature": FEATURE.replace("@S2 @R2", "@R2") });
    expect(msgs.some((m) => m.includes("시나리오 ID 태그(@S1 …)가 없습니다"))).toBe(true);
  });

  it("시나리오 ID가 겹침", () => {
    const msgs = check({ "login.feature": FEATURE.replace("@S2", "@S1") });
    expect(msgs.some((m) => m.includes("@S1가 겹칩니다"))).toBe(true);
  });

  it("시나리오에 요구사항 태그가 없음", () => {
    const msgs = check({ "login.feature": FEATURE.replace("@S2 @R2", "@S2") });
    expect(msgs.some((m) => m.includes("요구사항 태그(@R1 …)가 없습니다"))).toBe(true);
  });

  it("spec.md에 없는 요구사항을 가리킴", () => {
    expect(check({ "login.feature": FEATURE.replace("@S2 @R2", "@S2 @R9") }).some((m) => m.includes("없는 요구사항 @R9"))).toBe(true);
    expect(check({ "tasks.md": TASKS.replace("(R2)", "(R2, R9)") }).some((m) => m.includes("없는 요구사항 R9"))).toBe(true);
  });

  it("작업 ID나 요구사항 표시가 없음", () => {
    expect(check({ "tasks.md": TASKS.replace("T2 잠금", "잠금") }).some((m) => m.includes("작업 ID(T1 …)가 없습니다"))).toBe(true);
    expect(check({ "tasks.md": TASKS.replace(" (R2)", "") }).some((m) => m.includes("줄 끝에 요구사항 ID가 없습니다"))).toBe(true);
  });

  it("요구사항 ID가 겹침", () => {
    expect(check({ "spec.md": SPEC + "- R2 또 잠금\n" }).some((m) => m.includes("R2가 겹칩니다"))).toBe(true);
  });

  it("시나리오나 작업이 없는 요구사항", () => {
    const spec = SPEC + "- R3 남은 시간\n";
    const msgs = check({ "spec.md": spec });
    expect(msgs).toContain("R3: 이 요구사항을 검증하는 시나리오가 없습니다");
    expect(msgs).toContain("R3: 이 요구사항을 구현하는 작업이 없습니다");
  });

  it("파일이 빠짐", () => {
    const dir = featureDir({ "spec.md": SPEC, "tasks.md": TASKS });
    expect(errors(checkFeatureDir(dir).issues).map((i) => i.message)).toContain("시나리오 파일(.feature)이 없습니다");
  });
});

describe("시나리오 파일 읽기", () => {
  it("기능에 붙은 요구사항 태그는 모든 시나리오가 물려받는다", () => {
    const { scenarios } = parseFeature("@R1\n기능: 로그인\n\n  @S1\n  시나리오: 성공\n", "x.feature");
    expect(scenarios[0].reqs).toEqual(["R1"]);
  });

  it("단계 줄 뒤에 남은 태그는 다음 시나리오에 붙지 않는다", () => {
    const { scenarios, issues } = parseFeature("기능: 로그인\n  @S1 @R1\n  배경:\n    조건 준비\n  시나리오: 성공\n", "x.feature");
    expect(scenarios).toEqual([]);
    expect(issues[0].message).toContain("시나리오 ID 태그(@S1 …)가 없습니다");
  });
});
