// 조각 3 2단계: 기능마다 작업 유형, 화면 기능의 플랫폼별 인수 테스트 파일과 관문 실행.
// 진짜 기기·빌드 대신 가짜 명령(파일에 PASS가 있으면 통과)으로 N22·N26·N28을 돌린다.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { platformScenarios, runGate, taskPlatforms } from "../src/gate.ts";
import { fixtureDir, initProject } from "../src/init.ts";
import { readEvents } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { featurePlatforms, featureWorkType } from "../src/plan.ts";
import { PoError, tellStory } from "../src/po.ts";
import { readFileSync } from "node:fs";

const nodes = loadNodes();
let root = "";
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
// 파일마다 PASS가 있어야 통과하는 가짜 플로우 실행기
const FAKE_RUN = `sh -c 'for f in "$@"; do grep -q PASS "$f" || exit 1; done' run`;
const config = (build = "true") => `work_type: feature
profile: full
agent: claude
platforms: [android, web]
commands:
  unit: "true"
  acceptance: "true"
  run_files: "true"
  e2e:
    android:
      build: "${build}"
      run_files: "${FAKE_RUN.replaceAll('"', '\\"')}"
    web:
      run_files: "${FAKE_RUN.replaceAll('"', '\\"')}"
locked: ["specs/**", "design/**", "4dd.config.yaml", ".4dd/**"]
`;
const gate = (nodeId: string) => runGate({ root, config: loadConfig(root), nodes, nodeId, task: "T9", runId: "NR1" });

beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-platform-")), "proj");
  initProject(root, { from: fixtureDir("login-app"), install: false });
  put("4dd.config.yaml", config());
  put("specs/login-screen/story.md", "# 스토리: login-screen (HU1)\n\n작업 유형: mobile\n\n로그인 화면이 있으면 좋겠어요.\n");
  put(
    "specs/login-screen/spec.md",
    "# 요구사항 스펙: 로그인 화면 (N02)\n\n## 목적\n로그인 화면.\n\n## 요구사항\n- R10 아이디와 비밀번호로 로그인하면 환영 화면이 나온다.\n\n## 범위 밖\n- 없음\n\n## 제약\n- 없음\n\n## 물을 것\n- 없음\n",
  );
  put("specs/login-screen/login-screen.feature", "# language: ko\n기능: 로그인 화면\n\n  @S15 @R10\n  시나리오: 맞는 비밀번호로 로그인\n    만일 아이디 \"kim01\"로 로그인하면\n    그러면 환영 화면이 보인다\n");
  put("specs/login-screen/tasks.md", "# 작업 목록: 로그인 화면 (N14)\n\n- [ ] T9 로그인 화면 (R10)\n");
});

describe("기능마다 작업 유형 (조각 3)", () => {
  it("story.md 머리의 작업 유형을 읽고, 없으면 기능 단위 프로젝트에서는 backend", () => {
    expect(featureWorkType(root, "login-screen", "feature")).toBe("mobile");
    expect(featureWorkType(root, "signup", "feature")).toBe("backend");
    expect(featureWorkType(root, "signup", "web")).toBe("web");
  });

  it("mobile 기능은 설정의 플랫폼 전부, web 기능은 웹만, 백엔드는 없음", () => {
    expect(featurePlatforms("mobile", ["android", "web"])).toEqual(["android", "web"]);
    expect(featurePlatforms("web", ["android", "web"])).toEqual(["web"]);
    expect(featurePlatforms("backend", ["android", "web"])).toEqual([]);
    expect(taskPlatforms(root, loadConfig(root), "T9")).toEqual(["android", "web"]);
    expect(taskPlatforms(root, loadConfig(root), "T4")).toEqual([]);
  });

  it("4dd story --type이 story.md 머리에 작업 유형을 남기고, 잘못된 유형은 막는다", () => {
    const ENV = {} as NodeJS.ProcessEnv;
    const fresh = join(mkdtempSync(join(tmpdir(), "4dd-story-")), "proj");
    initProject(fresh, { from: fixtureDir("login-app"), install: false });
    tellStory(fresh, "signup-screen", "회원 가입 화면이 있으면 좋겠어요", { by: "script", type: "mobile" }, ENV);
    expect(readFileSync(join(fresh, "specs/signup-screen/story.md"), "utf8")).toContain("작업 유형: mobile");
    expect(featureWorkType(fresh, "signup-screen", "feature")).toBe("mobile");
    // 기능 단위가 아닌 프로젝트(login-reset은 backend)에서는 다른 유형을 받지 않는다
    const backend = join(mkdtempSync(join(tmpdir(), "4dd-story-")), "proj");
    initProject(backend, { from: fixtureDir("login-reset"), install: false });
    expect(() => tellStory(backend, "screen", "화면", { by: "script", type: "mobile" }, ENV)).toThrow(PoError);
  });

  it("화면 시나리오의 인수 테스트는 플랫폼마다 Maestro 플로우와 Playwright 파일", () => {
    expect(platformScenarios(root, "T9", "android").files).toEqual(["tests/e2e/android/S15.yaml"]);
    expect(platformScenarios(root, "T9", "web").files).toEqual(["tests/e2e/web/S15.spec.ts"]);
  });
});

describe("화면 기능의 관문 (조각 3)", () => {
  it("N22: 플랫폼마다 플로우가 없으면 실패하고 두 파일을 알려 준다", () => {
    const r = gate("N22");
    expect(r.passed).toBe(false);
    expect(r.summary).toContain("tests/e2e/android/S15.yaml");
    expect(r.summary).toContain("tests/e2e/web/S15.spec.ts");
  });

  it("N22: 플로우가 있고 아직 실패하면 통과, 원장에 플랫폼별 실행이 남는다", () => {
    put("tests/e2e/android/S15.yaml", "appId: com.fourdd.loginapp\n---\n- launchApp\n- assertVisible: \"환영\"\n");
    put("tests/e2e/web/S15.spec.ts", 'import { test } from "@playwright/test";\ntest("S15", async () => {});\n');
    const r = gate("N22");
    expect(r.passed, r.summary).toBe(true);
    const runs = readEvents(root).events.filter((e) => e.type === "gate_run" && e.node === "N22").slice(-3);
    expect(runs.map((e) => (e.type === "gate_run" ? `${e.platform}:${e.result}` : ""))).toEqual(["android:pass", "android:pass", "web:pass"]);
  });

  it("N26: 플로우가 통과하면 통과, 한 플랫폼이라도 실패하면 실패", () => {
    put("tests/e2e/android/S15.yaml", "appId: com.fourdd.loginapp\n---\n- launchApp\n# PASS\n");
    expect(gate("N26").passed).toBe(false); // 웹은 아직 실패
    put("tests/e2e/web/S15.spec.ts", 'import { test } from "@playwright/test";\ntest("S15", async () => {}); // PASS\n');
    expect(gate("N26").passed).toBe(true);
  });

  it("N26: 앱 빌드가 깨지면 그 플랫폼의 플로우는 돌리지 않고 실패", () => {
    put("4dd.config.yaml", config("false"));
    const r = gate("N26");
    expect(r.passed).toBe(false);
    const runs = r.runs.map((x) => x.command);
    expect(runs.some((c) => c === "false")).toBe(true);
    expect(runs.filter((c) => c.includes("tests/e2e/android/")).length).toBe(0);
    expect(runs.filter((c) => c.includes("tests/e2e/web/")).length).toBe(1);
    put("4dd.config.yaml", config());
  });

  it("N28: 단위·인수 테스트에 더해 플랫폼마다 플로우 전체를 돌린다", () => {
    const r = gate("N28");
    const cmds = r.runs.map((x) => x.command);
    expect(cmds.slice(0, 2)).toEqual(["true", "true"]);
    expect(cmds.some((c) => c.includes("tests/e2e/android/S15.yaml"))).toBe(true);
    expect(cmds.some((c) => c.includes("tests/e2e/web/S15.spec.ts"))).toBe(true);
  });
});
