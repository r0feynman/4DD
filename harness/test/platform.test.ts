// 조각 3 2단계: 기능마다 작업 유형, 화면 기능의 플랫폼별 인수 테스트 파일과 관문 실행.
// 진짜 기기·빌드 대신 가짜 명령(파일에 PASS가 있으면 통과)으로 N22·N26·N28을 돌린다.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { buildContext } from "../src/context.ts";
import { platformScenarios, runGate, taskPlatforms } from "../src/gate.ts";
import { fixtureDir, initProject } from "../src/init.ts";
import { readEvents } from "../src/ledger.ts";
import { failRoute, loadNodes, nextNode } from "../src/nodes.ts";
import { PNG } from "pngjs";
import { compareShot, visualSettings } from "../src/visual.ts";
import { featurePlatforms, featureWorkType } from "../src/plan.ts";
import { PoError, tellStory } from "../src/po.ts";
import { checkCodeConnect, checkFrames, checkStates, checkTokens } from "../src/design.ts";
import { hashFiles, reviewFilesFor } from "../src/plan.ts";
import { renderReviewPage } from "../src/review.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { git } from "../src/git.ts";
import { readFileSync } from "node:fs";

const nodes = loadNodes();
let root = "";
const put = (rel: string, text: string | Buffer) => {
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

  it("N28: 플랫폼에 플로우가 하나도 없으면(서버만 바꾼 첫 작업) 그 플랫폼은 빌드도 돌리지 않는다", () => {
    expect(gate("N28").runs.map((x) => x.command)).toEqual(["true", "true"]);
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

describe("디자인 산출물 관문 (조각 3)", () => {
  // 1080×2400 PNG 머리만 있는 가짜 이미지
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };

  it("토큰: 네 묶음이 있고 테마가 토큰 파일을 가져다 써야 통과", () => {
    expect(checkTokens(root).ok).toBe(false);
    put("design/tokens.json", JSON.stringify({ color: { text: "#111" }, space: { s: 8 }, font: { family: "Noto Sans KR" }, radius: { m: 8 } }));
    put("mobile/theme.ts", "export const theme = { text: \"#111\" };\n");
    expect(checkTokens(root).detail).toContain("import");
    put("mobile/theme.ts", 'import tokens from "../design/tokens.json";\nexport const theme = tokens;\n');
    expect(checkTokens(root).ok).toBe(true);
  });

  it("Code Connect: 컴포넌트 넷이 노드와 코드 파일에 이어져야 통과", () => {
    put("design/code-connect.json", JSON.stringify([{ component: "Button", figma: "1:2", code: "mobile/ui/Button.tsx" }]));
    put("mobile/ui/Button.tsx", "export {};\n");
    const r = checkCodeConnect(root);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("TextField: 연결 없음");
    const all = ["Button", "TextField", "Text", "Banner"].map((c, i) => ({ component: c, figma: `1:${i + 2}`, code: `mobile/ui/${c}.tsx` }));
    for (const c of all) put(c.code, "export {};\n");
    put("design/code-connect.json", JSON.stringify(all));
    expect(checkCodeConnect(root).ok).toBe(true);
  });

  it("화면 상태: 시나리오마다 다섯 상태를 채우거나 화면 없음의 이유를 적어야 통과", () => {
    put("specs/login-screen/states.md", "## S15\n- 성공: 환영 화면\n- 실패: 안내 띠\n");
    expect(checkStates(root, "login-screen").detail).toContain("빈 상태, 로딩, 오류");
    put("specs/login-screen/states.md", "## S15\n- 성공: 환영\n- 실패: 띠\n- 빈 상태: 해당 없음: 첫 화면\n- 로딩: 버튼 비활성\n- 오류: 띠\n");
    expect(checkStates(root, "login-screen").ok).toBe(true);
  });

  it("프레임: 시나리오마다 프레임 줄과 1080×2400 이미지가 있어야 하고, 프레임 줄 말고는 시나리오를 바꿀 수 없다", () => {
    const file = "specs/login-screen/login-screen.feature";
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fixture"], { FOURDD_ALLOW_LOCKED: "1" });
    expect(checkFrames(root, "login-screen").detail).toContain("프레임 줄이 없음");
    const text = readFileSync(join(root, file), "utf8").replace("  @S15 @R10", "  # figma: 12:345\n  @S15 @R10");
    put(file, text);
    put("design/frames/S15.png", png(360, 800));
    expect(checkFrames(root, "login-screen").detail).toContain("1080×2400");
    put("design/frames/S15.png", png(1080, 2400));
    expect(checkFrames(root, "login-screen").ok).toBe(true);
    put(file, text.replace("환영 화면이 보인다", "다른 화면이 보인다"));
    expect(checkFrames(root, "login-screen").detail).toContain("프레임 줄 말고 시나리오가 바뀌었습니다");
    put(file, text);
  });
});

describe("화면 기능의 N04 검토 페이지 (조각 3)", () => {
  it("시나리오 카드에 프레임 이미지와 상태, 처음이면 디자인 시스템을 넣고, 이미지도 검토 해시에 들어간다", () => {
    // 앞 묶음이 states.md, design/frames/S15.png, tokens·code-connect를 만들어 두었다
    const files = reviewFilesFor(root, "login-screen", ["story", "spec", "scenarios", "states", "frames", "design_system"]);
    expect(files).toContain("design/frames/S15.png");
    expect(files).toContain("specs/login-screen/states.md");
    expect(files).toContain("design/tokens.json");
    const hashed = hashFiles(root, files);
    const n00f = { ...{ ts: "2026-11-27T00:00:00.000Z", schema_version: 1 as const, harness: "0.3.0" }, type: "node_end", id: "NR9", node: "N00F", task: null, feature: "login-screen", result: "pass", loaded: [], minutes: 0 } as LedgerEvent;
    const html = renderReviewPage({ root, node: nodes.nodes.N04, feature: "login-screen", id: "RV1", hash: "abc", files: hashed, events: [n00f] });
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("디자인 시스템 (처음 한 번)");
    expect(html).toContain('class="st na"'); // 빈 상태: 해당 없음
    const storyBox = /<section class="story">.*?<\/section>/s.exec(html)?.[0] ?? "";
    expect(storyBox).toContain("로그인 화면이 있으면 좋겠어요");
    expect(storyBox).not.toContain("작업 유형"); // 스토리 칸에는 PO의 말만 (원문 칸에는 파일 그대로)
    // 디자인 시스템을 앞 기능에서 만들었으면 다시 보이지 않는다
    expect(renderReviewPage({ root, node: nodes.nodes.N04, feature: "login-screen", id: "RV1", hash: "abc", files: hashed, events: [] })).not.toContain("디자인 시스템 (처음 한 번)");
  });
});

describe("Stage 2 화면 작업의 맥락 (조각 3)", () => {
  it("N22는 플랫폼별 파일 표·기준 화면·상태·부품·앱 ID를, N24는 이미 쓴 플로우까지 받는다", () => {
    // 앞 묶음들이 플로우(N22 관문), states.md, design/frames/S15.png, code-connect를 만들어 두었다
    const n22 = buildContext({ root, nodes, nodeId: "N22", task: "T9" }).prompt;
    expect(n22).toContain("### 화면 작업 (플랫폼: android, web)");
    expect(n22).toContain("| S15 | `design/frames/S15.png` | `tests/e2e/android/S15.yaml` | `tests/e2e/web/S15.spec.ts` |");
    expect(n22).toContain("#### 화면 상태");
    expect(n22).toContain("Android 앱 ID(Maestro의 `appId`): `com.fourdd.loginapp`");
    expect(n22).toContain("`mobile/theme.ts`");
    expect(n22).not.toContain("#### tests/e2e/android/S15.yaml");
    const n24 = buildContext({ root, nodes, nodeId: "N24", task: "T9" }).prompt;
    expect(n24).toContain("#### tests/e2e/android/S15.yaml");
    expect(n24).toContain("- launchApp");
    expect(n24).toContain("(빼고: `mobile/theme.ts`");
  });

  it("백엔드 기능의 작업에는 화면 작업 칸이 없다", () => {
    put("specs/login-screen/story.md", "# 스토리: login-screen (HU1)\n\n작업 유형: backend\n\n로그인 화면이 있으면 좋겠어요.\n");
    try {
      expect(buildContext({ root, nodes, nodeId: "N22", task: "T9" }).prompt).not.toContain("### 화면 작업");
    } finally {
      put("specs/login-screen/story.md", "# 스토리: login-screen (HU1)\n\n작업 유형: mobile\n\n로그인 화면이 있으면 좋겠어요.\n");
    }
  });
});

describe("화면 비교 N26F (조각 3)", () => {
  const W = 1080;
  const H = 2400;
  /** 흰 바탕에 [y0, y1) 줄을 칠한 PNG */
  const png = (paint: [number, number][] = []) => {
    const p = new PNG({ width: W, height: H });
    p.data.fill(255);
    for (const [y0, y1] of paint) for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) p.data[(y * W + x) * 4] = 0;
    return PNG.sync.write(p);
  };

  it("같으면 0%, 다른 줄의 비율을 재고, 위·아래 띠(상태 표시줄 자리)는 빼고 본다", () => {
    put("design/frames/S15.png", png());
    put(".4dd/shots/android/S15.png", png([[0, 90]])); // 상태 표시줄 자리만 다름 → 0%
    const s = visualSettings(loadConfig(root));
    expect(compareShot(root, "S15", "android", s)).toMatchObject({ ok: true, diffPercent: 0 });
    put(".4dd/shots/android/S15.png", png([[1000, 1223]])); // 가운데 223줄 ≈ 9.9%
    const r = compareShot(root, "S15", "android", s);
    expect(r.ok).toBe(false);
    expect(r.diffPercent).toBeGreaterThan(9);
    expect(readFileSync(join(root, r.diff!)).length).toBeGreaterThan(0);
  });

  it("N26F 관문: 플랫폼마다 비교하고, 찍은 화면이 없으면 실패", () => {
    put(".4dd/shots/android/S15.png", png());
    expect(gate("N26F").passed).toBe(false); // 웹 화면이 없음
    expect(gate("N26F").checks[0].detail).toContain("web S15: 찍은 화면이 없습니다");
    put(".4dd/shots/web/S15.png", png([[500, 520]])); // 20줄 ≈ 0.9% → 허용 5% 안
    expect(gate("N26F").passed).toBe(true);
  });

  it("화면 기능은 N26 뒤 N26F, 백엔드는 N27; ui_mismatch는 N24로", () => {
    expect(nextNode(nodes, "N26", "mobile")).toBe("N26F");
    expect(nextNode(nodes, "N26", "backend")).toBe("N27");
    expect(failRoute(nodes, "N26F", "ui_mismatch")).toEqual({ goto: "N24" });
    expect(failRoute(nodes, "N26F", "design_wrong")).toEqual({ goto: "N03F", then: "N22", confirm: true });
  });
});
