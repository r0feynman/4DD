// 조각 2: Stage 0·1의 관문 검사, 다음 할 일 정하기, 상태 접기
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { runGate } from "../src/gate.ts";
import { fixtureDir, initProject } from "../src/init.ts";
import { appendEvent, readEvents, type LedgerEvent } from "../src/ledger.ts";
import { loadNodes, parseNodes, NodesError, resolveWrites, sessionScope } from "../src/nodes.ts";
import { combinedHash, hashFiles, openQuestions, readSprint, reviewFilesFor } from "../src/plan.ts";
import { decideNext } from "../src/route.ts";
import { unapprovedDrift } from "../src/run.ts";
import { rebuildState } from "../src/state.ts";

const nodes = loadNodes();
const H = nodes.version;
const F = "password-reset";
let root = "";
let config: Config;

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const gate = (nodeId: string, task: string | null = null) => runGate({ root, config, nodes, nodeId, task, feature: F, runId: "NR1" });
const failed = (nodeId: string, task: string | null = null) => gate(nodeId, task).checks.filter((c) => !c.ok).map((c) => c.detail).join("\n");

const SPEC = `# 요구사항 스펙: 비밀번호 재설정 (N02)

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
- 없음
`;
const FEATURE = `# language: ko
기능: 비밀번호 재설정

  @S4 @R4
  시나리오: 링크 만들기
    만일 재설정을 요청하면
    그러면 응답 상태는 202이다

  @S5 @R5
  시나리오: 링크로 바꾸기
    만일 링크로 새 비밀번호를 정하면
    그러면 응답 상태는 200이다
`;
const DESIGN = `# 설계

## 구조
src/reset.ts (R4, R5)

## API
POST /password-reset (S4), POST /password-reset/confirm (S5)

## 데이터 모델
토큰 저장소

## 규칙
30분

## 기존 기능에 주는 영향
src/lockout.ts의 잠금을 푼다
`;
const TASKS = "# 작업 목록: 비밀번호 재설정 (N14)\n\n- [ ] T4 재설정 링크 API (R4)\n- [ ] T5 링크로 비밀번호 바꾸기 (R5)\n";
const SPRINT = `# 스프린트

## 목표
비밀번호를 잊은 사용자가 스스로 다시 로그인할 수 있다.

## 기능
- ${F}

## 백로그
- T4
- T5
`;

beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-plan-")), "proj");
  initProject(root, { from: fixtureDir("login-reset"), install: false });
  config = loadConfig(root);
});

describe("Stage 0·1 관문 검사", () => {
  it("N02: 스펙 칸이 모자라면 실패, 다 있으면 통과", () => {
    put(`specs/${F}/spec.md`, SPEC.replace("## 제약\n", "## 제약사항\n"));
    expect(failed("N02")).toContain("칸이 없습니다: ## 제약");
    put(`specs/${F}/spec.md`, SPEC);
    expect(gate("N02").passed).toBe(true);
  });

  it("N02: 다른 기능(로그인)과 요구사항 ID가 겹치면 실패", () => {
    put(`specs/${F}/spec.md`, SPEC.replace("R4 재설정", "R2 재설정"));
    expect(failed("N02")).toContain("R2가 다른 기능(specs/login)에도 있습니다");
    put(`specs/${F}/spec.md`, SPEC);
  });

  it("N03: 시나리오가 없는 요구사항을 잡고, 작업 목록은 아직 보지 않는다", () => {
    put(`specs/${F}/${F}.feature`, FEATURE.replace("@S5 @R5", "@S5 @R4"));
    expect(failed("N03")).toContain("R5: 이 요구사항을 검증하는 시나리오가 없습니다");
    put(`specs/${F}/${F}.feature`, FEATURE);
    const r = gate("N03");
    expect(r.passed).toBe(true);
  });

  it("N13: 설계 칸과, 요구사항·시나리오를 다루는 곳의 ID", () => {
    put(`specs/${F}/design.md`, DESIGN.replace(" (S5)", ""));
    expect(failed("N13")).toContain("ID로 적지 않은 요구사항·시나리오: S5");
    put(`specs/${F}/design.md`, DESIGN);
    expect(gate("N13").checks.every((c) => c.ok)).toBe(true);
  });

  it("N14: 작업이 없는 요구사항과 다른 기능과 겹치는 작업 ID를 잡는다", () => {
    put(`specs/${F}/tasks.md`, "- [ ] T4 재설정 링크 API (R4)\n");
    expect(failed("N14")).toContain("R5: 이 요구사항을 구현하는 작업이 없습니다");
    put(`specs/${F}/tasks.md`, TASKS.replace("T5 링크", "T3 링크"));
    expect(failed("N14")).toContain("T3가 다른 기능(specs/login)에도 있습니다");
    put(`specs/${F}/tasks.md`, TASKS);
    expect(gate("N14").checks.every((c) => c.ok)).toBe(true);
  });

  it("N11과 N15: 목표 한 문장과 기능, 백로그의 작업 ID", () => {
    put("specs/sprint.md", SPRINT.replace(`- ${F}`, "- login"));
    expect(failed("N11")).toContain(`## 기능에 ${F}가 없습니다`);
    put("specs/sprint.md", SPRINT.replace("- T5\n", "- T9\n"));
    const msg = failed("N15");
    expect(msg).toContain("이번 스프린트 기능에 없는 작업: T9");
    expect(msg).toContain("백로그에 빠진 작업: T5");
    put("specs/sprint.md", SPRINT);
    expect(gate("N11").passed).toBe(true);
    expect(gate("N15").passed).toBe(true);
    expect(readSprint(root)).toEqual({ goal: "비밀번호를 잊은 사용자가 스스로 다시 로그인할 수 있다.", features: [F], backlog: ["T4", "T5"] });
  });

  it("N12: 승인된 패킷이 없으면 실패, 승인 뒤 파일이 바뀌면 실패", () => {
    expect(failed("N12")).toContain("패킷 0 → 1)가 없습니다");
    const files = hashFiles(root, reviewFilesFor(root, F, ["story", "spec", "scenarios"]));
    appendEvent(root, H, { type: "packet", id: "PK1", boundary: "0-1", feature: F, files, refs: ["R4", "R5", "S4", "S5"], review: "RV1" });
    expect(gate("N12").passed).toBe(true);
    put(`specs/${F}/spec.md`, SPEC + "\n덧붙임\n");
    expect(failed("N12")).toContain(`N04에서 승인한 뒤 바뀐 파일이 있습니다: specs/${F}/spec.md`);
    put(`specs/${F}/spec.md`, SPEC);
  });

  it("Stage 2에서 돌아온 N02는 요구사항을 더하거나 빼지 못한다", () => {
    expect(gate("N02").checks.find((c) => c.name === "requirements_kept")?.detail).toBe("처음 쓰는 스펙이라 해당 없음");
    put(`specs/${F}/spec.md`, SPEC.replace("## 범위 밖", "- R6 새 요구\n\n## 범위 밖"));
    expect(failed("N02", "T4")).toContain("더함 R6");
    put(`specs/${F}/spec.md`, SPEC);
    expect(gate("N02", "T4").passed).toBe(true);
  });
});

describe("재사용 전 검증 (조각 2 실제 실행에서 찾은 빈틈)", () => {
  it("다시 돌 노드가 고칠 수 있는 잠긴 파일의 커밋 전 변경은 승인 없이 바뀐 기준으로 보지 않는다", () => {
    put(`specs/${F}/tasks.md`, TASKS);
    const tasks = `specs/${F}/tasks.md`;
    expect(unapprovedDrift(root, config, nodes, "N14", F)).not.toContain(tasks);
    expect(unapprovedDrift(root, config, nodes, "N15", F)).toContain(tasks);
    expect(unapprovedDrift(root, config, nodes, null, F)).toContain(tasks);
  });
});

describe("파일 읽기 도우미", () => {
  it("물을 것: 「없음」은 질문이 아니다", () => {
    expect(openQuestions(SPEC)).toEqual([]);
    expect(openQuestions(SPEC.replace("- 없음", "- 링크를 두 번 누르면?\n- 메일을 실제로 보내나요?"))).toEqual(["링크를 두 번 누르면?", "메일을 실제로 보내나요?"]);
  });

  it("검토 해시는 파일 순서와 상관없이 같고, 내용이 바뀌면 달라진다", () => {
    const a = hashFiles(root, [`specs/${F}/spec.md`, `specs/${F}/story.md`]);
    const b = hashFiles(root, [`specs/${F}/story.md`, `specs/${F}/spec.md`]);
    expect(combinedHash(a)).toBe(combinedHash(b));
    expect(a.find((f) => f.path.endsWith("story.md"))?.hash).toBe("missing");
    expect(combinedHash(a)).not.toBe(combinedHash([{ ...a[0], hash: "x" }, a[1]]));
  });

  it("writes의 {feature}와 세션 단위", () => {
    expect(resolveWrites(nodes.nodes.N02, F)).toEqual([`specs/${F}/spec.md`]);
    expect(resolveWrites(nodes.nodes.N02, null)).toEqual([]);
    expect(sessionScope(nodes.nodes.N02)).toBe("stage");
    expect(sessionScope(nodes.nodes.N24)).toBe("task");
  });
});

// ---------------------------------------------------------------- 다음 할 일 (Stage 0·1)

const base = { ts: "2026-11-25T00:00:00.000Z", schema_version: 1 as const, harness: "0.2.0" };
let n = 0;
const end = (node: string, result: "pass" | "fail" | "wait", extra: Record<string, unknown> = {}): LedgerEvent =>
  ({ ...base, type: "node_end", id: `NR${++n}`, node, task: null, feature: F, result, loaded: [], minutes: 0, ...extra }) as LedgerEvent;
const tend = (node: string, result: "pass" | "fail" | "wait", extra: Record<string, unknown> = {}): LedgerEvent =>
  ({ ...base, type: "node_end", id: `NR${++n}`, node, task: "T4", feature: F, result, loaded: [], minutes: 0, ...extra }) as LedgerEvent;
const human = (kind: string, node: string, extra: Record<string, unknown> = {}): LedgerEvent =>
  ({ ...base, type: "human", id: `HU${++n}`, node, task: null, kind, feature: F, ...extra }) as LedgerEvent;
const story = (): LedgerEvent => human("story", "N01", { by: "po", channel: "chat" });
const awaitReview = (node: string): LedgerEvent => ({ ...base, type: "await_human", node, task: null, feature: F, reason: "review" }) as LedgerEvent;
const packet = (boundary: "0-1" | "1-2"): LedgerEvent =>
  ({ ...base, type: "packet", id: `PK${++n}`, boundary, feature: F, files: [{ path: "x", hash: "y" }], refs: [], review: "RV1" }) as LedgerEvent;
const next = (events: LedgerEvent[]) => decideNext(events, nodes, "backend", rebuildState(events));

describe("다음 할 일 정하기 (Stage 0·1)", () => {
  it("스토리를 받으면 N02부터 순서대로, N04에서 사람 승인을 기다린다", () => {
    const ev = [story()];
    expect(rebuildState(ev).planning).toBe(F);
    expect(next(ev)).toEqual({ kind: "node", node: "N02" });
    expect(next([...ev, end("N02", "fail")])).toEqual({ kind: "node", node: "N02" });
    expect(next([...ev, end("N02", "pass")])).toEqual({ kind: "node", node: "N03" });
    expect(next([...ev, end("N02", "pass"), end("N03", "pass")])).toEqual({ kind: "node", node: "N04" });
    const wait = [...ev, end("N02", "pass"), end("N03", "pass"), end("N04", "wait"), awaitReview("N04")];
    expect(rebuildState(wait).status).toBe("waiting_human");
    expect(next(wait)).toEqual({ kind: "human", node: "N04", reason: "review" });
  });

  it("N04 승인이면 N11, 되돌림이면 원인 경로(N02)로", () => {
    const wait = [story(), end("N02", "pass"), end("N03", "pass"), end("N04", "wait"), awaitReview("N04")];
    expect(next([...wait, human("approve", "N04", { review: "RV1" }), packet("0-1")])).toEqual({ kind: "node", node: "N11" });
    expect(next([...wait, human("reject", "N04", { review: "RV1", cause: "spec_missing_state" })])).toEqual({ kind: "node", node: "N02" });
  });

  it("N15가 통과하면 승인을 기다리고, 승인되면 패킷 1 → 2와 함께 작업 고르기로", () => {
    const upTo15 = [story(), end("N02", "pass"), end("N03", "pass"), end("N04", "wait"), human("approve", "N04", { review: "RV1" }), packet("0-1"), end("N11", "pass"), end("N12", "pass"), end("N13", "pass"), end("N14", "pass"), end("N15", "pass")];
    expect(next(upTo15)).toEqual({ kind: "human", node: "N15", reason: "review" });
    const approved = [...upTo15, awaitReview("N15"), human("approve", "N15", { review: "RV2" }), packet("1-2")];
    expect(rebuildState(approved).planning).toBeNull();
    expect(next(approved)).toEqual({ kind: "pick" });
    expect(next([...upTo15, awaitReview("N15"), human("reject", "N15", { review: "RV2", to: "N14" })])).toEqual({ kind: "node", node: "N14" });
  });

  it("N12가 준비 안 됨이면 사람을 기다리고, 승인 뒤 스토리(N01)부터", () => {
    const ev = [story(), end("N02", "pass"), end("N03", "pass"), end("N04", "wait"), human("approve", "N04", { review: "RV1" }), packet("0-1"), end("N11", "pass"), end("N12", "fail")];
    expect(next(ev)).toEqual({ kind: "human", node: "N12", reason: "not_ready" });
    expect(next([...ev, human("approve", "N12")])).toEqual({ kind: "node", node: "N01" });
    expect(next([...ev, human("approve", "N12"), story()])).toEqual({ kind: "node", node: "N02" });
    expect(rebuildState([...ev, human("hold", "N12")]).planning).toBeNull();
  });

  it("Stage 2의 설계 원인(arch_wrong)은 승인 뒤 N13 → N14 → N15 승인 → 다음 작업 고르기", () => {
    const pre = [tend("N21", "pass"), tend("N27", "fail", { cause: "arch_wrong" })];
    expect(next(pre)).toEqual({ kind: "human", node: "N27", reason: "arch_wrong" });
    const ok = [...pre, { ...human("approve", "N27", { reason: "arch_wrong" }), task: "T4" } as LedgerEvent];
    expect(next(ok)).toEqual({ kind: "node", node: "N13" });
    const at15 = [...ok, tend("N13", "pass"), tend("N14", "pass"), tend("N15", "pass")];
    expect(next(at15)).toEqual({ kind: "human", node: "N15", reason: "review" });
    expect(next([...at15, { ...human("approve", "N15", { review: "RV3" }), task: "T4" } as LedgerEvent])).toEqual({ kind: "pick" });
  });
});

describe("노드 정의 형식 검사 (조각 2)", () => {
  const dir = join(dirname(nodes.dir), "nodes");
  const HEAD = "version: 0.2.0\ndefaults: {budget: 3, task_budget: 10, flaky_retries: 1, turn_timeout_min: 15}\n";
  const problems = (yaml: string): string[] => {
    try {
      parseNodes(HEAD + yaml, dir);
      return [];
    } catch (e) {
      if (e instanceof NodesError) return e.problems;
      throw e;
    }
  };
  const HUMAN = "N04:\n  name: 승인\n  stage: 0\n  method: sdd\n  kind: decision\n  actor: human\n";

  it("사람 판단 노드에는 승인과 검토 페이지가 함께, 지시문과 관문은 없이", () => {
    const p = problems(HUMAN + "  on_fail:\n    - when: spec_ambiguous\n      goto: N04\n");
    expect(p).toContain("N04: 사람이 판정하는 노드에는 승인(approve)이 있어야 합니다");
    expect(problems(HUMAN + '  approve: {packet: "0-1"}\n  on_fail:\n    - when: spec_ambiguous\n      goto: N04\n')).toContain("N04: 사람 승인 노드에는 검토 페이지(review)와 승인(approve)이 함께 있어야 합니다");
    expect(problems(HUMAN + '  review: [spec]\n  approve: {packet: "0-1"}\n  instruction: instructions/N02.md\n  on_fail:\n    - when: spec_ambiguous\n      goto: N04\n')).toContain("N04: 하네스나 사람이 하는 노드에는 지시문을 두지 않습니다");
  });

  it("앞 스테이지로 돌아가는 경로에는 then과 confirm이 있어야 한다", () => {
    const yaml = HUMAN + '  review: [spec]\n  approve: {packet: "0-1"}\n  on_fail:\n    - when: spec_ambiguous\n      goto: N04\n' +
      "N26:\n  name: 판단\n  stage: 2\n  method: bdd\n  kind: decision\n  actor: harness\n  gate: {run: x, expect: pass}\n  on_fail:\n    - when: spec_ambiguous\n      goto: N04\n";
    const p = problems(yaml);
    expect(p).toContain("N26: 앞 스테이지(N04)로 돌아가는 경로에는 승인 뒤 돌아올 곳(then)이 있어야 합니다");
    expect(p).toContain("N26: 앞 스테이지(N04)로 돌아가는 경로는 사람이 먼저 승인해야 합니다 (confirm: true)");
  });

  it("관문에는 명령·검사·리뷰 가운데 하나, 명령에는 expect", () => {
    const W = "N11:\n  name: 목표\n  stage: 1\n  method: scrum\n  kind: work\n  actor: worker\n  instruction: instructions/N11.md\n";
    expect(problems(W + "  gate: {}\n").some((p) => p.includes("관문에는 명령, 검사, 리뷰 가운데 하나는"))).toBe(true);
    expect(problems(W + "  gate: {run: x}\n").some((p) => p.includes("expect(pass·fail)도"))).toBe(true);
    expect(problems(W + "  gate: {checks: [sprint_goal]}\n")).toEqual([]);
  });

  it("on_reject는 같은 스테이지의 노드로, 승인이 있는 작업 노드에만", () => {
    const W = "N15:\n  name: 백로그\n  stage: 1\n  method: scrum\n  kind: work\n  actor: worker\n  instruction: instructions/N15.md\n  gate: {checks: [backlog_ids]}\n";
    expect(problems(W + "  on_reject: [N15]\n")).toContain("N15: on_reject는 사람 승인이 있는 작업 노드에만 씁니다 (판단 노드는 on_fail)");
    expect(problems(W + '  review: [sprint]\n  approve: {packet: "1-2"}\n  on_reject: [N15]\n')).toEqual([]);
  });
});

it("원장: 새 이벤트(검토, 패킷, 사람 대기)를 쓰고 읽는다", () => {
  appendEvent(root, H, { type: "review", id: "RV9", action: "built", node: "N04", task: null, feature: F, files: [{ path: "a", hash: "b" }], hash: "h" });
  appendEvent(root, H, { type: "await_human", node: "N04", task: null, feature: F, reason: "review" });
  appendEvent(root, H, { type: "human", id: "HU9", node: "N04", task: null, kind: "approve", feature: F, review: "RV9", by: "po", channel: "chat", text_hash: "q" });
  const evs = readEvents(root).events.slice(-3);
  expect(evs.map((e) => e.type)).toEqual(["review", "await_human", "human"]);
  expect(() => appendEvent(root, H, { type: "review", id: "RV10", action: "built", node: "N04", task: null, feature: "Bad Name", hash: "h" })).toThrow(/기능 이름/);
});
