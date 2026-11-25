// 조각 2: PO 창구의 사람 명령 (스토리, 검토 페이지, 승인과 되돌림)과 승인을 지키는 겹
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/git.ts";
import { fixtureDir, initProject } from "../src/init.ts";
import { appendEvent, nextId, readEvents } from "../src/ledger.ts";
import { bashViolation } from "../src/lock.ts";
import { loadNodes } from "../src/nodes.ts";
import { approveReview, buildReview, PoError, recordPublished, rejectReview, tellStory } from "../src/po.ts";
import { decideNext } from "../src/route.ts";
import { loadState } from "../src/state.ts";

const nodes = loadNodes();
const H = nodes.version;
const F = "password-reset";
const ENV = {} as NodeJS.ProcessEnv;
let root = "";

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commitAll = (msg: string) => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", msg], { FOURDD_ALLOW_LOCKED: "1" });
};
/** 지휘 프로그램이 노드를 통과시킨 것처럼 원장에 남긴다 */
const passed = (node: string, result: "pass" | "wait" = "pass") => {
  const id = nextId(readEvents(root).events, "NR");
  appendEvent(root, H, { type: "node_start", id, node, task: null, feature: F, session: null });
  appendEvent(root, H, { type: "node_end", id, node, task: null, feature: F, result, minutes: 0 });
  if (result === "wait") appendEvent(root, H, { type: "await_human", node, task: null, feature: F, reason: "review" });
};
/** 원장은 커밋한 뒤에 그 커밋을 적으므로 한 커밋 늦게 들어간다. 그 밖의 변경이 없어야 한다 */
const dirty = () => git(root, ["status", "--porcelain"]).split("\n").filter((l) => l.trim() && !l.endsWith(".4dd/events.jsonl")).join("\n");
const next = () => {
  const { events } = readEvents(root);
  return decideNext(events, nodes, "backend", loadState(root).state);
};

const SPEC = (questions: string) => `# 요구사항 스펙: 비밀번호 재설정 (N02)

## 목적
비밀번호를 잊은 사용자가 재설정 링크로 새 비밀번호를 정한다.

## 요구사항
- R4 재설정을 요청하면 30분 동안 쓸 수 있는 링크를 만든다.
- R5 링크로 새 비밀번호를 정하면 잠긴 계정도 풀린다.

## 범위 밖
- 메일 발송 서버

## 제약
- 링크는 한 번만 쓴다.

## 물을 것
${questions}
`;
const FEATURE = `# language: ko
기능: 비밀번호 재설정

  배경:
    조건 아이디 "kim"인 사용자가 가입되어 있다

  @S4 @R4
  시나리오: 링크 만들기
    만일 재설정을 요청하면
    그러면 응답 상태는 202이다

  @S5 @R5
  시나리오: 링크로 바꾸기
    만일 링크로 새 비밀번호를 정하면
    그러면 응답 상태는 200이다
`;

beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-po-")), "proj");
  initProject(root, { from: fixtureDir("login-reset"), install: false });
});

describe("4dd story (N01)", () => {
  it("하네스가 띄운 세션에서는 사람 명령을 쓸 수 없다", () => {
    expect(() => tellStory(root, F, "재설정", {}, { FOURDD_NODE: "N24" } as NodeJS.ProcessEnv)).toThrow(/하네스가 띄운 세션\(N24\)/);
  });

  it("기능 이름은 영문 소문자와 -만, 이미 있는 기능은 안 됨", () => {
    expect(() => tellStory(root, "Password Reset", "재설정", {}, ENV)).toThrow(/기능 이름/);
    expect(() => tellStory(root, "login", "재설정", {}, ENV)).toThrow(/이미 있는 기능/);
  });

  it("PO의 말을 그대로 story.md로 남기고, 그 기능의 Stage 0을 시작한다", () => {
    const msg = tellStory(root, F, "비밀번호를 잊으면 링크로 바꾸고 싶어요", { by: "po", channel: "chat" }, ENV);
    expect(msg).toContain("스토리를 받았습니다");
    expect(readFileSync(join(root, `specs/${F}/story.md`), "utf8")).toContain("비밀번호를 잊으면 링크로 바꾸고 싶어요");
    const s = loadState(root).state;
    expect(s.planning).toBe(F);
    expect(next()).toEqual({ kind: "node", node: "N02" });
    expect(git(root, ["log", "-1", "--format=%s"]).trim()).toBe(`N01: 스토리 (${F})`);
    expect(dirty()).toBe("");
  });

  it("Stage 0·1을 도는 기능이 있으면 새 스토리를 받지 않는다", () => {
    expect(() => tellStory(root, "signup", "가입", {}, ENV)).toThrow(/이미 Stage 0·1을 도는 기능이 있습니다/);
  });
});

describe("검토 페이지와 승인 (N04)", () => {
  it("승인을 기다리는 중이 아니면 검토 페이지를 만들지 않는다", () => {
    expect(() => buildReview(root, ENV)).toThrow(/검토 승인을 기다리는 중이 아닙니다/);
  });

  it("검토 페이지: 요구사항·시나리오 카드와 물을 것, 원장에 해시", () => {
    put(`specs/${F}/spec.md`, SPEC("- 메일을 실제로 보내나요?"));
    put(`specs/${F}/${F}.feature`, FEATURE);
    commitAll("N02, N03");
    passed("N02");
    passed("N03");
    passed("N04", "wait");
    expect(next()).toEqual({ kind: "human", node: "N04", reason: "review" });
    const r = buildReview(root, ENV);
    expect(r).toMatchObject({ id: "RV1", node: "N04", feature: F, title: "비밀번호 재설정 검토" });
    const html = readFileSync(join(root, r.file), "utf8");
    expect(html).toContain("<title>비밀번호 재설정 검토</title>");
    expect(html).toContain("답이 필요한 것 1개");
    expect(html).toContain('<span class="id id-R">R4</span>');
    expect(html).toContain('<span class="id id-S">S5</span>');
    expect(html).toContain("모든 시나리오의 시작");
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/<script/i);
    const ev = readEvents(root).events.filter((e) => e.type === "review").at(-1);
    expect(ev).toMatchObject({ type: "review", id: "RV1", action: "built", node: "N04", feature: F });
    expect(dirty()).toBe("");
  });

  it("물을 것이 남아 있으면 승인하지 않는다", () => {
    expect(() => approveReview(root, "RV1", "승인", {}, ENV)).toThrow(/답하지 않은 물을 것이 1개/);
  });

  it("되돌림: 원인을 골라야 하고, PO의 말은 힌트와 학습 후보가 된다", () => {
    expect(() => rejectReview(root, "RV1", "메일은 보내지 않아요", {}, ENV)).toThrow(/원인을 고릅니다: spec_ambiguous, spec_missing_state/);
    const msg = rejectReview(root, "RV1", "메일은 실제로 보내지 않고 화면에 링크를 보여 줘요", { cause: "spec_ambiguous" }, ENV);
    expect(msg).toContain("학습 후보");
    expect(next()).toEqual({ kind: "node", node: "N02" });
    const hu = readEvents(root).events.filter((e) => e.type === "human").at(-1);
    expect(hu).toMatchObject({ kind: "reject", review: "RV1", cause: "spec_ambiguous", by: "po", channel: "chat" });
    expect(readFileSync(join(root, `.4dd/human/${hu?.type === "human" ? hu.id : ""}.md`), "utf8")).toContain("화면에 링크를 보여 줘요");
    expect(existsSync(join(root, ".4dd/learnings.yaml"))).toBe(true);
  });

  it("예전 페이지로는 답하지 않고, 페이지를 보낸 뒤 파일이 바뀌면 승인을 거부한다", () => {
    put(`specs/${F}/spec.md`, SPEC("- 없음"));
    commitAll("N02 다시");
    passed("N02");
    passed("N03");
    passed("N04", "wait");
    const r2 = buildReview(root, ENV);
    expect(r2.id).toBe("RV2");
    expect(() => approveReview(root, "RV1", "승인", {}, ENV)).toThrow(/RV1는|RV1보다 새 검토 페이지 RV2/);
    put(`specs/${F}/spec.md`, SPEC("- 없음") + "\n(몰래 고침)\n");
    expect(() => approveReview(root, "RV2", "승인", {}, ENV)).toThrow(/검토 페이지를 보낸 뒤 파일이 바뀌었습니다: specs\/password-reset\/spec.md/);
    put(`specs/${F}/spec.md`, SPEC("- 없음"));
  });

  it("승인: 패킷 0 → 1에 파일 해시와 ID를 고정하고 N11로", () => {
    expect(recordPublished(root, "https://claude.ai/artifact/abc", undefined, ENV)).toContain("RV2 게시 주소");
    const msg = approveReview(root, "RV2", "좋아요 승인", {}, ENV);
    expect(msg).toContain("패킷 0-1");
    const pk = readEvents(root).events.filter((e) => e.type === "packet").at(-1);
    expect(pk).toMatchObject({ type: "packet", boundary: "0-1", feature: F, review: "RV2", refs: ["R4", "R5", "S4", "S5"] });
    expect(pk?.type === "packet" ? pk.files.map((f) => f.path) : []).toEqual([`specs/${F}/${F}.feature`, `specs/${F}/spec.md`, `specs/${F}/story.md`]);
    expect(next()).toEqual({ kind: "node", node: "N11" });
    expect(loadState(root).state.status).toBe("running");
    expect(git(root, ["log", "-1", "--format=%B"])).toContain("4DD-Review: RV2");
  });
});

describe("승인을 지키는 겹: 작업 세션의 셸 훅", () => {
  it("사람 명령은 셸에서 막고, 따옴표 안의 글은 막지 않는다", () => {
    for (const cmd of ["4dd human approve --review RV2 --quote ok", "node /x/harness/src/cli.ts story --feature a b", "FOO=1 npx 4dd review", "cd x && ./node_modules/.bin/4dd human reject --review RV1"]) {
      expect(bashViolation(cmd), cmd).toMatch(/사람\(PO 창구\)만 부릅니다/);
    }
    for (const cmd of ["echo '4dd human approve'", "4dd status", "node src/cli.ts check trace", "npx vitest run"]) {
      expect(bashViolation(cmd), cmd).toBeNull();
    }
  });
});

it("PoError는 잘못된 사용을 알린다", () => {
  expect(new PoError("x")).toBeInstanceOf(Error);
});
