// 조각 2: 각본 에이전트와 각본 PO로 스토리부터 Stage 2 끝까지 (실제 Vitest로 관문을 돌린다)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest, TurnResult } from "../src/adapters.ts";
import { git } from "../src/git.ts";
import { fixtureDir, initProject } from "../src/init.ts";
import { appendEvent, nextId, readEvents } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { approveReview, buildReview, rejectReview, tellStory } from "../src/po.ts";
import { runLoop } from "../src/run.ts";
import { buildReport, renderReport } from "../src/report.ts";
import { loadState } from "../src/state.ts";

const nodes = loadNodes();
const F = "password-reset";
const SCRIPT = { by: "script" as const, channel: "terminal" as const };
const ENV = {} as NodeJS.ProcessEnv;
let root = "";

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const SPEC = (questions: string) =>
  `# 요구사항 스펙: 비밀번호 재설정 (N02)\n\n## 목적\n비밀번호를 잊은 사용자가 링크로 새 비밀번호를 정한다.\n\n## 요구사항\n- R4 재설정을 요청하면 30분 동안 쓸 수 있는 링크를 만든다.\n- R5 링크로 새 비밀번호를 정하면 잠긴 계정도 풀린다.\n\n## 범위 밖\n- 메일 발송 서버\n\n## 제약\n- 링크는 한 번만 쓴다.\n\n## 물을 것\n${questions}\n`;
const FEATURE = `# language: ko\n기능: 비밀번호 재설정\n\n  @S4 @R4\n  시나리오: 링크 만들기\n    만일 재설정을 요청하면\n    그러면 응답 상태는 202이다\n\n  @S5 @R5\n  시나리오: 링크로 바꾸기\n    만일 링크로 새 비밀번호를 정하면\n    그러면 응답 상태는 200이다\n`;
const DESIGN = `# 설계: 비밀번호 재설정\n\n## 구조\nsrc/t4.ts (R4), src/t5.ts (R5)\n\n## API\nPOST /password-reset (S4), POST /password-reset/confirm (S5)\n\n## 데이터 모델\n토큰\n\n## 규칙\n30분\n\n## 기존 기능에 주는 영향\n없음\n`;
const TASKS = "# 작업 목록: 비밀번호 재설정 (N14)\n\n- [ ] T4 재설정 링크 API (R4)\n- [ ] T5 링크로 비밀번호 바꾸기 (R5)\n";
const SPRINT = (backlog: string) => `# 스프린트\n\n## 목표\n비밀번호를 잊은 사용자가 스스로 다시 로그인할 수 있다.\n\n## 기능\n- ${F}\n\n## 백로그\n${backlog}`;

/** Stage 0·1은 정해진 문서를 쓰고, Stage 2는 작업 Tn마다 시나리오 Sn과 src/tn.ts를 쓰는 각본 에이전트 */
function planningAgent(): Adapter & { calls: { node: string; unit: string; session: string | null; readOnly: boolean }[] } {
  const calls: { node: string; unit: string; session: string | null; readOnly: boolean }[] = [];
  const units: Record<string, number> = {};
  return {
    agent: "claude",
    calls,
    runTurn(req: TurnRequest): TurnResult {
      const node = req.env.FOURDD_NODE;
      const task = /^# 4DD 하네스 · .* · 작업 (T\d+)$/m.exec(req.prompt)?.[1];
      const unit = task ?? `${req.env.FOURDD_FEATURE}@${node[1]}`;
      calls.push({ node, unit, session: req.sessionId, readOnly: !!req.readOnly });
      if (req.sessionId === null) {
        const { events } = readEvents(req.root);
        appendEvent(req.root, nodes.version, { type: "hook_run", id: nextId(events, "HR"), hook: "claude.session_start", check: "session", run: req.env.FOURDD_NODE_RUN, result: "allowed" });
      }
      const done = (extra: Partial<TurnResult> = {}): TurnResult => ({ ok: true, sessionId: req.sessionId ?? `sess-${unit}`, text: "끝", tokens: { input: 10, output: 5 }, costUsd: 0.01, minutes: 0.1, turns: 2, timedOut: false, ...extra });
      if (req.readOnly) return done({ sessionId: `review-${calls.length}`, structured: { pass: true, cause: null, fix_in: null, findings: [] } });
      if (node === "N02") put(`specs/${F}/spec.md`, SPEC(req.prompt.includes("### PO의 말") ? "- 없음" : "- 메일을 실제로 보내나요?"));
      if (node === "N03") put(`specs/${F}/${F}.feature`, FEATURE);
      if (node === "N11") put("specs/sprint.md", SPRINT(""));
      if (node === "N13") put(`specs/${F}/design.md`, DESIGN);
      if (node === "N14") put(`specs/${F}/tasks.md`, TASKS);
      if (node === "N15") put("specs/sprint.md", SPRINT("- T4\n- T5\n"));
      if (task) {
        const k = task.slice(1);
        if (node === "N22") put(`tests/acceptance/S${k}.test.ts`, `import { test, expect } from "vitest";\nimport { ok } from "../../src/t${k}.ts";\ntest("S${k}", () => { expect(ok).toBe(true); });\n`);
        if (node === "N23") {
          const i = (units[task] = (units[task] ?? 0) + 1);
          put(`tests/unit/t${k}_${i}.test.ts`, `import { test, expect } from "vitest";\nimport * as m from "../../src/t${k}.ts";\ntest("t${k} ${i}", () => { expect((m as Record<string, unknown>).v${i}).toBe(true); });\n`);
        }
        if (node === "N24") put(`src/t${k}.ts`, ["export const ok = true;", ...Array.from({ length: units[task] ?? 0 }, (_, j) => `export const v${j + 1} = true;`)].join("\n") + "\n");
      }
      return done();
    },
  };
}

const seq = () =>
  readEvents(root)
    .events.filter((e) => e.type === "node_end" && (e.feature === F || (e.task && ["T4", "T5"].includes(e.task))))
    .map((e) => (e.type === "node_end" ? `${e.node}${e.task ? `/${e.task}` : ""}:${e.result}` : ""));

describe("각본 PO로 스토리부터 Stage 2 끝까지 (로그인에 두 번째 기능)", () => {
  const agent = planningAgent();

  beforeAll(() => {
    // 로그인 코드가 fastify를 쓰므로, 하네스의 node_modules를 빌리지 않고 시험 프로젝트의 의존 패키지를 설치한다
    root = join(mkdtempSync(join(tmpdir(), "4dd-stage01-")), "proj");
    initProject(root, { from: fixtureDir("login-reset") });
  }, 180_000);

  it("스토리를 받으면 N02, N03을 돌고 N04에서 검토 승인을 기다리며 끝난다", () => {
    tellStory(root, F, "비밀번호를 잊으면 링크로 바꾸고 싶어요", SCRIPT, ENV);
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("wait_human");
    expect(r.message).toContain("검토 승인을 기다립니다");
    expect(seq()).toEqual(["N01:pass", "N02:pass", "N03:pass", "N04:wait"]);
    expect(loadState(root).state.waiting).toMatchObject({ node: "N04", reason: "review" });
    // 기다리는 동안 다시 돌려도 아무것도 하지 않는다
    expect(runLoop({ root, adapter: agent }).reason).toBe("wait_human");
  });

  it("물을 것이 있으면 승인하지 못하고, PO의 답으로 되돌리면 N02가 그 말을 받아 고친다 (같은 Stage 0 세션)", () => {
    const rv1 = buildReview(root, ENV);
    expect(() => approveReview(root, rv1.id, "승인", SCRIPT, ENV)).toThrow(/물을 것/);
    rejectReview(root, rv1.id, "메일은 보내지 않고 응답으로 링크를 줘요", { ...SCRIPT, cause: "spec_ambiguous" }, ENV);
    const r = runLoop({ root, adapter: agent });
    expect(r.reason).toBe("wait_human");
    expect(readFileSync(join(root, `specs/${F}/spec.md`), "utf8")).toContain("## 물을 것\n- 없음");
    const n02 = agent.calls.filter((c) => c.node === "N02");
    expect(n02).toHaveLength(2);
    expect(n02[1].session).toBe(`sess-${F}@0`);
  });

  it("N04 승인 뒤 Stage 1(N11~N15, 리뷰 세션 둘)을 돌고 N15에서 다시 승인을 기다린다", () => {
    approveReview(root, buildReview(root, ENV).id, "좋아요", SCRIPT, ENV);
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("wait_human");
    expect(seq().filter((x) => /^N1\d/.test(x))).toEqual(["N11:pass", "N12:pass", "N13:pass", "N14:pass", "N15:pass"]);
    expect(agent.calls.filter((c) => c.readOnly).map((c) => c.node)).toEqual(["N13", "N14"]);
    const stage1 = agent.calls.filter((c) => !c.readOnly && /^N1/.test(c.node));
    expect(stage1[0].session).toBeNull();
    expect(stage1.slice(1).every((c) => c.session === `sess-${F}@1`)).toBe(true);
    expect(loadState(root).state.waiting).toMatchObject({ node: "N15", reason: "review" });
  });

  it("N15 승인(패킷 1 → 2) 뒤 백로그 순서대로 T4, T5를 끝내고, 로그인 테스트도 그대로 통과한다", () => {
    approveReview(root, buildReview(root, ENV).id, "시작해요", SCRIPT, ENV);
    expect(loadState(root).state.planning).toBeNull();
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("done");
    expect(loadState(root).state.done_tasks).toEqual(["T4", "T5"]);
    expect(readFileSync(join(root, `specs/${F}/tasks.md`), "utf8")).toMatch(/- \[x\] T4[\s\S]*- \[x\] T5/);
    const packets = readEvents(root).events.filter((e) => e.type === "packet").map((e) => (e.type === "packet" ? e.boundary : ""));
    expect(packets).toEqual(["0-1", "1-2"]);
    // 각본 PO의 개입은 사람 개입 수에 넣지 않도록 by: script로 남는다
    const humans = readEvents(root).events.filter((e) => e.type === "human" && e.feature === F);
    expect(humans.every((e) => e.type === "human" && e.by === "script")).toBe(true);
    expect(git(root, ["status", "--porcelain"]).split("\n").filter((l) => l.trim() && !l.endsWith("events.jsonl"))).toEqual([]);
  });

  it("보고서: 기능별 사람 개입(각본 PO는 따로), 사람 대기, N04 되돌림 원인, 스테이지별 토큰", () => {
    const r = buildReport(readEvents(root).events, nodes);
    const f = r.features.find((x) => x.feature === F)!;
    expect(f.humansTotal).toBe(0);
    expect(f.scripted).toBe(4); // 스토리, N04 되돌림, N04 승인, N15 승인
    expect(f.n04Rejects).toEqual({ spec_ambiguous: 1 });
    expect(f.waits.map((w) => `${w.review}:${w.node}`)).toEqual(["RV1:N04", "RV2:N04", "RV3:N15"]);
    expect(f.stages.map((s) => s.stage)).toEqual([0, 1, 2]);
    expect(f.stages.every((s) => s.tokens > 0 || s.stage === 0)).toBe(true);
    expect(r.totals.humansPerTask).toBe(0);
    expect(renderReport(r)).toContain("## 기능별 (Stage 0·1, 조각 2)");
  });
});
