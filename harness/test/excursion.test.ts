// 조각 2: Stage 2에서 스펙 원인이 나오면 PO 승인 뒤 N02 → N03 → N04 승인 → 원래 작업의 N22로 (각본 테스트)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest, TurnResult } from "../src/adapters.ts";
import { humanAction } from "../src/human.ts";
import { fixtureDir, initProject } from "../src/init.ts";
import { appendEvent, nextId, readEvents } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { approveReview, buildReview, tellStory } from "../src/po.ts";
import { runLoop } from "../src/run.ts";
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

const SPEC = (extra = "") =>
  `# 요구사항 스펙: 비밀번호 재설정 (N02)\n\n## 목적\n링크로 새 비밀번호를 정한다.\n\n## 요구사항\n- R4 재설정을 요청하면 링크를 만든다.${extra}\n- R5 링크로 새 비밀번호를 정한다.\n\n## 범위 밖\n- 메일 서버\n\n## 제약\n- 한 번만 쓴다.\n\n## 물을 것\n- 없음\n`;
const FEATURE = `# language: ko\n기능: 비밀번호 재설정\n\n  @S4 @R4\n  시나리오: 링크 만들기\n    만일 요청하면\n    그러면 202이다\n\n  @S5 @R5\n  시나리오: 바꾸기\n    만일 바꾸면\n    그러면 200이다\n`;
const DESIGN = `# 설계\n\n## 구조\nsrc/t4.ts (R4), src/t5.ts (R5)\n\n## API\nS4, S5\n\n## 데이터 모델\n토큰\n\n## 규칙\n30분\n\n## 기존 기능에 주는 영향\n없음\n`;

function agentWithSpecGap(): Adapter & { calls: string[] } {
  const calls: string[] = [];
  const units: Record<string, number> = {};
  let firstN24T4 = true;
  return {
    agent: "claude",
    calls,
    runTurn(req: TurnRequest): TurnResult {
      const node = req.env.FOURDD_NODE;
      const task = /^# 4DD 하네스 · .* · 작업 (T\d+)$/m.exec(req.prompt)?.[1];
      calls.push(`${node}${task ? `/${task}` : ""}${req.readOnly ? ":ro" : ""}`);
      if (req.sessionId === null) {
        const { events } = readEvents(req.root);
        appendEvent(req.root, nodes.version, { type: "hook_run", id: nextId(events, "HR"), hook: "claude.session_start", check: "session", run: req.env.FOURDD_NODE_RUN, result: "allowed" });
      }
      const done = (extra: Partial<TurnResult> = {}): TurnResult => ({ ok: true, sessionId: req.sessionId ?? `sess-${calls.length}`, text: "끝", minutes: 0.1, timedOut: false, ...extra });
      if (req.readOnly) {
        // N26 분류 차례: 스펙이 모호하다고 고른다. 그 밖(N13·N14·N27 리뷰)은 통과.
        if (node === "N26") return done({ structured: { cause: "spec_ambiguous", evidence: "링크를 몇 번 쓸 수 있는지 스펙에 없음" } });
        return done({ structured: { pass: true, cause: null, fix_in: null, findings: [] } });
      }
      // Stage 2에서 돌아온 N02는 PO의 답을 반영해 R4의 문장만 고친다
      if (node === "N02") put(`specs/${F}/spec.md`, SPEC(task ? " 링크는 한 번만 쓸 수 있다." : ""));
      if (node === "N03") put(`specs/${F}/${F}.feature`, FEATURE);
      if (node === "N11") put("specs/sprint.md", `# 스프린트\n\n## 목표\n스스로 다시 로그인한다.\n\n## 기능\n- ${F}\n\n## 백로그\n`);
      if (node === "N13") put(`specs/${F}/design.md`, DESIGN);
      if (node === "N14") put(`specs/${F}/tasks.md`, "# 작업 목록\n\n- [ ] T4 링크 API (R4)\n- [ ] T5 바꾸기 (R5)\n");
      if (node === "N15") put("specs/sprint.md", `# 스프린트\n\n## 목표\n스스로 다시 로그인한다.\n\n## 기능\n- ${F}\n\n## 백로그\n- T4\n- T5\n`);
      if (task) {
        const k = task.slice(1);
        if (node === "N22") put(`tests/acceptance/S${k}.test.ts`, `import { test, expect } from "vitest";\nimport { ok } from "../../src/t${k}.ts";\ntest("S${k}", () => { expect(ok).toBe(true); });\n`);
        if (node === "N23") {
          const i = (units[task] = (units[task] ?? 0) + 1);
          put(`tests/unit/t${k}_${i}.test.ts`, `import { test, expect } from "vitest";\nimport * as m from "../../src/t${k}.ts";\ntest("t${k} ${i}", () => { expect((m as Record<string, unknown>).v${i}).toBe(true); });\n`);
        }
        if (node === "N24") {
          // T4의 첫 구현은 시나리오를 채우지 못한다 (N26이 실패하고, 분류가 스펙의 빈틈을 고름)
          const ok = !(task === "T4" && firstN24T4);
          if (task === "T4") firstN24T4 = false;
          put(`src/t${k}.ts`, [`export const ok = ${ok};`, ...Array.from({ length: units[task] ?? 0 }, (_, j) => `export const v${j + 1} = true;`)].join("\n") + "\n");
        }
      }
      return done();
    },
  };
}

describe("Stage 2에서 스펙으로 돌아갔다 오기", () => {
  const agent = agentWithSpecGap();

  beforeAll(() => {
    root = join(mkdtempSync(join(tmpdir(), "4dd-excursion-")), "proj");
    initProject(root, { from: fixtureDir("login-reset") });
    tellStory(root, F, "링크로 비밀번호를 바꾸고 싶어요", SCRIPT, ENV);
    expect(runLoop({ root, adapter: agent }).reason).toBe("wait_human");
    approveReview(root, buildReview(root, ENV).id, "승인", SCRIPT, ENV);
    expect(runLoop({ root, adapter: agent }).reason).toBe("wait_human");
    approveReview(root, buildReview(root, ENV).id, "승인", SCRIPT, ENV);
  }, 180_000);

  it("N26에서 spec_ambiguous가 나오면 사람의 승인을 기다린다", () => {
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("wait_human");
    expect(loadState(root).state.waiting).toMatchObject({ node: "N26", task: "T4", reason: "spec_ambiguous" });
  });

  it("PO의 답과 함께 승인하면 같은 작업으로 N02 → N03 → N04에서 다시 검토 승인을 기다린다", () => {
    humanAction(root, "approve", "링크는 한 번만 쓸 수 있어요");
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("wait_human");
    const t4 = readEvents(root).events.filter((e) => e.type === "node_end" && e.task === "T4").map((e) => (e.type === "node_end" ? `${e.node}:${e.result}` : ""));
    expect(t4.slice(-3)).toEqual(["N02:pass", "N03:pass", "N04:wait"]);
    expect(loadState(root).state.waiting).toMatchObject({ node: "N04", task: "T4", reason: "review" });
  });

  it("N04를 다시 승인하면 원래 작업의 N22로 돌아와 T4와 T5를 끝낸다", () => {
    const rv = buildReview(root, ENV);
    approveReview(root, rv.id, "승인", SCRIPT, ENV);
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("done");
    const t4 = readEvents(root).events.filter((e) => e.type === "node_end" && e.task === "T4").map((e) => (e.type === "node_end" ? e.node : ""));
    const back = t4.lastIndexOf("N04");
    expect(t4[back + 1]).toBe("N22");
    expect(loadState(root).state.done_tasks).toEqual(["T4", "T5"]);
    // 돌아온 N02는 PO의 답을 맥락으로 받았다
    expect(agent.calls.filter((c) => c === "N02/T4")).toHaveLength(1);
    const packets = readEvents(root).events.filter((e) => e.type === "packet").map((e) => (e.type === "packet" ? e.boundary : ""));
    expect(packets).toEqual(["0-1", "1-2", "0-1"]);
  });
});
