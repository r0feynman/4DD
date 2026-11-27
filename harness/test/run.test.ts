// 지휘 루프를 각본대로 움직이는 가짜 에이전트로 시험한다. 실제 Vitest로 관문을 돌린다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest, TurnResult } from "../src/adapters.ts";
import { git } from "../src/git.ts";
import { humanAction } from "../src/human.ts";
import { initProject } from "../src/init.ts";
import { appendEvent, nextId, readEvents } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { runLoop } from "../src/run.ts";
import { loadState } from "../src/state.ts";

const harnessModules = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
const nodes = loadNodes();
let root = "";

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

interface Script {
  /** 이 노드·작업에서 일을 하지 않는 횟수 (관문 실패를 일으킨다) */
  lazy?: Record<string, number>;
  /** 리뷰 결과를 차례로 */
  reviews?: { pass: boolean; cause: "code_bug" | "arch_wrong" | null; fix_in?: "behavior" | "structure" | "acceptance_test" | "unit_test" }[];
  /** 힌트를 받으면 그때부터 제대로 한다 */
  fixOnHint?: boolean;
}

/** 각본대로 움직이는 가짜 에이전트. 작업 Tn은 시나리오 Sn, 모듈 src/tn.ts를 쓴다. */
function scriptedAgent(script: Script = {}): Adapter & { calls: { node: string; task: string }[] } {
  const calls: { node: string; task: string }[] = [];
  const lazy = { ...(script.lazy ?? {}) };
  const reviews = [...(script.reviews ?? [])];
  const units: Record<string, number> = {};
  return {
    agent: "claude",
    calls,
    runTurn(req: TurnRequest): TurnResult {
      const node = req.env.FOURDD_NODE;
      const task = /작업 (T\d+)/.exec(req.prompt)?.[1] ?? "T?";
      calls.push({ node, task });
      if (req.sessionId === null) {
        const { events } = readEvents(req.root);
        appendEvent(req.root, nodes.version, { type: "hook_run", id: nextId(events, "HR"), hook: "claude.session_start", check: "session", run: req.env.FOURDD_NODE_RUN, result: "allowed" });
      }
      const done = (extra: Partial<TurnResult> = {}): TurnResult => ({ ok: true, sessionId: req.sessionId ?? `sess-${task}`, text: "끝", tokens: { input: 10, output: 5 }, costUsd: 0.01, minutes: 0.1, turns: 2, timedOut: false, ...extra });
      if (req.readOnly) {
        const v = reviews.shift() ?? { pass: true, cause: null };
        const file = v.fix_in === "acceptance_test" ? "tests/acceptance/S1.test.ts" : "src/t1.ts";
        return done({ sessionId: `review-${calls.length}`, structured: { fix_in: v.pass ? null : (v.fix_in ?? "behavior"), ...v, findings: v.pass ? [] : [{ file, line: 1, why: "설계와 다름" }] } });
      }
      const key = `${node}:${task}`;
      const hinted = script.fixOnHint && req.prompt.includes("### 사람이 준 힌트");
      if ((lazy[key] ?? 0) > 0 && !hinted) {
        lazy[key]--;
        return done();
      }
      const k = task.slice(1);
      if (node === "N22") put(`tests/acceptance/S${k}.test.ts`, `import { test, expect } from "vitest";\nimport { ok } from "../../src/t${k}.ts";\ntest("S${k}", () => { expect(ok).toBe(true); });\n`);
      if (node === "N23" && req.prompt.includes("N23에서 테스트만 더함")) {
        // 리뷰가 단위 테스트만 요구함: 이미 있는 동작(ok)을 확인하는 테스트라 처음부터 통과한다
        put(`tests/unit/t${k}_after.test.ts`, `import { test, expect } from "vitest";\nimport { ok } from "../../src/t${k}.ts";\ntest("t${k} after", () => { expect(ok).toBe(true); });\n`);
        return done();
      }
      if (node === "N23") {
        const i = (units[task] = (units[task] ?? 0) + 1);
        put(`tests/unit/t${k}_${i}.test.ts`, `import { test, expect } from "vitest";\nimport * as m from "../../src/t${k}.ts";\ntest("t${k} ${i}", () => { expect((m as Record<string, unknown>).v${i}).toBe(true); });\n`);
      }
      if (node === "N24") put(`src/t${k}.ts`, ["export const ok = true;", ...Array.from({ length: units[task] ?? 0 }, (_, j) => `export const v${j + 1} = true;`)].join("\n") + "\n");
      return done();
    },
  };
}

const nodeSeq = (task: string) => readEvents(root).events.filter((e) => e.type === "node_end" && e.task === task).map((e) => (e.type === "node_end" ? `${e.node}:${e.result}` : ""));

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-run-")), "proj");
  initProject(root, { install: false });
  symlinkSync(harnessModules, join(root, "node_modules"), "dir");
});

describe("지휘 루프", () => {
  it("작업 세 개를 N21부터 N29까지 사람 손 없이 끝낸다", () => {
    const agent = scriptedAgent();
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("done");
    expect(nodeSeq("T1")).toEqual(["N21:pass", "N22:pass", "N23:pass", "N24:pass", "N25:pass", "N26:pass", "N27:pass", "N28:pass", "N29:pass"]);
    expect(loadState(root).state.done_tasks).toEqual(["T1", "T2", "T3"]);
    expect(readFileSync(join(root, "specs/login/tasks.md"), "utf8")).toMatch(/- \[x\] T1[\s\S]*- \[x\] T2[\s\S]*- \[x\] T3/);
    // 노드마다 커밋하고, 트레일러로 원장과 잇는다
    const log = git(root, ["log", "--format=%s%n%b"]);
    expect(log).toContain("N24 T2: Green · 통과하게 구현");
    expect(log).toContain("4DD-Refs: R2,S2");
    expect(git(root, ["status", "--porcelain", "--", ".", ":!.4dd/events.jsonl"]).trim()).toBe("");
    // 작업 세션은 작업마다 하나, 리뷰 세션은 매번 새로
    const sessions = readEvents(root).events.filter((e) => e.type === "node_start" && e.node === "N23").map((e) => (e.type === "node_start" ? e.session : null));
    expect(sessions).toEqual(["sess-T1", "sess-T2", "sess-T3"]);
  });

  it("--max-tasks로 작업 하나만 하고 멈춘다", () => {
    const r = runLoop({ root, adapter: scriptedAgent(), maxTasks: 1 });
    expect(r.reason).toBe("paused");
    expect(loadState(root).state.status).toBe("idle");
    expect(loadState(root).state.done_tasks).toEqual(["T1"]);
  });

  it("리뷰가 code_bug로 실패하면 N23에서 새 실패 테스트부터 다시 돌고 통과한다", () => {
    const r = runLoop({ root, adapter: scriptedAgent({ reviews: [{ pass: false, cause: "code_bug" }] }), maxTasks: 1 });
    expect(r.reason, r.message).toBe("paused");
    expect(nodeSeq("T1")).toEqual([
      "N21:pass", "N22:pass", "N23:pass", "N24:pass", "N25:pass", "N26:pass", "N27:fail",
      "N23:pass", "N24:pass", "N25:pass", "N26:pass", "N27:pass", "N28:pass", "N29:pass",
    ]);
    // 리뷰 지적이 다음 N23 차례의 맥락에 들어갔는지는 원장의 리뷰 요약 파일로 확인
    const review = readEvents(root).events.find((e) => e.type === "node_end" && e.node === "N27" && e.result === "fail");
    expect(review && readFileSync(join(root, ".4dd/gates", `${review.type === "node_end" ? review.id : ""}.summary.md`), "utf8")).toContain("설계와 다름");
  });

  it("작업 노드가 횟수 한도를 넘으면 멈추고, 사람이 힌트를 주면 이어 간다", () => {
    const agent = scriptedAgent({ lazy: { "N24:T1": 9 }, fixOnHint: true });
    const first = runLoop({ root, adapter: agent, maxTasks: 1 });
    expect(first.reason).toBe("wait_human");
    expect(first.message).toContain("횟수 제한을 넘었습니다 (N24 연속 3번");
    expect(loadState(root).state.waiting).toEqual({ node: "N24", task: "T1", reason: "budget_exceeded" });
    // 기다리는 중에는 다시 돌려도 바로 멈춘다
    expect(runLoop({ root, adapter: agent }).reason).toBe("wait_human");

    const msg = humanAction(root, "hint", "src/t1.ts에 ok를 true로 내보내세요");
    expect(msg).toContain("학습 후보 L1");
    expect(existsSync(join(root, ".4dd/learnings.yaml"))).toBe(true);
    // 힌트 글과 학습 후보는 바로 커밋된다 (2026-11-26: 커밋하지 않아 다음 노드의 변경 검사가 지웠음)
    expect(git(root, ["status", "--porcelain", "--", ".4dd/human", ".4dd/learnings.yaml"]).trim()).toBe("");
    const second = runLoop({ root, adapter: agent, maxTasks: 1 });
    expect(second.reason, second.message).toBe("paused");
    expect(loadState(root).state.done_tasks).toEqual(["T1"]);
    const humans = readEvents(root).events.filter((e) => e.type === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({ kind: "hint", node: "N24", task: "T1", reason: "budget_exceeded" });
    expect(existsSync(join(root, `.4dd/human/${humans[0].type === "human" ? humans[0].id : ""}.md`))).toBe(true);
    const blocked = readEvents(root).events.filter((e) => e.type === "hook_run" && e.check === "diff_lock" && String(e.target ?? "").startsWith(".4dd/"));
    expect(blocked).toEqual([]);
  });

  it("리뷰가 arch_wrong이면 사람을 기다리고, 보류하면 다음 작업으로 간다", () => {
    const agent = scriptedAgent({ reviews: [{ pass: false, cause: "arch_wrong" }] });
    const r = runLoop({ root, adapter: agent });
    expect(r.reason).toBe("wait_human");
    expect(loadState(root).state.waiting).toMatchObject({ node: "N27", reason: "arch_wrong" });
    humanAction(root, "hold");
    const r2 = runLoop({ root, adapter: agent });
    expect(r2.reason).toBe("done");
    expect(loadState(root).state).toMatchObject({ held_tasks: ["T1"], done_tasks: ["T2", "T3"] });
  });

  it("잠긴 파일이 승인 없이 바뀌면 멈추고, 사람이 승인하면 기준을 새로 고정하고 이어 간다", () => {
    const agent = scriptedAgent();
    expect(runLoop({ root, adapter: agent, maxTasks: 1 }).reason).toBe("paused");
    writeFileSync(join(root, "specs/login/design.md"), readFileSync(join(root, "specs/login/design.md"), "utf8") + "\n사람이 고침\n");
    const r = runLoop({ root, adapter: agent, maxTasks: 1 });
    expect(r.reason).toBe("stopped");
    expect(r.message).toContain("잠긴 파일이 기준 해시와 다릅니다: specs/login/design.md");
    // --to는 approve에만, 같은 스테이지의 아는 노드만
    expect(() => humanAction(root, "approve", undefined, undefined, { to: "N99" })).toThrow("모르는 노드");
    expect(() => humanAction(root, "approve", undefined, undefined, { to: "N13" })).toThrow("같은 스테이지");
    expect(humanAction(root, "approve", undefined, undefined, { by: "dev" })).toContain("기준 해시를 새로 고정");
    expect(readEvents(root).events.filter((e) => e.type === "human").at(-1)).toMatchObject({ kind: "approve", by: "dev" });
    expect(git(root, ["status", "--porcelain", "--", ".", ":!.4dd/events.jsonl"]).trim()).toBe("");
    const r2 = runLoop({ root, adapter: agent });
    expect(r2.reason, r2.message).toBe("done");
  });
});

describe("이미 충족된 작업 (2026-11-25 오너 결정)", () => {
  it("앞 작업이 몫까지 구현했으면 N22에서 이미 충족으로 보고 N26으로 가고, 리뷰가 테스트를 확인한다", () => {
    const prompts: { node: string; task: string; prompt: string }[] = [];
    const base = scriptedAgent();
    const agent: Adapter = {
      agent: "claude",
      runTurn(req) {
        const task = /작업 (T\d+)/.exec(req.prompt)?.[1] ?? "T?";
        prompts.push({ node: req.env.FOURDD_NODE, task, prompt: req.prompt });
        const r = base.runTurn(req);
        // T2를 구현하면서 T3의 몫(src/t3.ts)까지 만들어 버린다
        if (req.env.FOURDD_NODE === "N24" && task === "T2") put("src/t3.ts", "export const ok = true;\n");
        return r;
      },
    };
    const r = runLoop({ root, adapter: agent });
    expect(r.reason, r.message).toBe("done");
    expect(nodeSeq("T3")).toEqual(["N21:pass", "N22:pass", "N26:pass", "N27:pass", "N28:pass", "N29:pass"]);
    const n22 = readEvents(root).events.find((e) => e.type === "node_end" && e.task === "T3" && e.node === "N22");
    expect(n22).toMatchObject({ already_met: true });
    const review = prompts.find((p) => p.node === "N27" && p.task === "T3");
    expect(review?.prompt).toContain("### 이미 충족된 작업");
    expect(review?.prompt).toContain("tests/acceptance/S3.test.ts");
    expect(prompts.filter((p) => p.task === "T3" && ["N23", "N24", "N25"].includes(p.node))).toEqual([]);
  });
});

describe("리뷰가 인수 테스트를 고치라고 할 때", () => {
  it("fix_in이 acceptance_test면 N23 대신 N22로 가서 인수 테스트를 고치고, 그다음 N26으로 바로 간다", () => {
    const r = runLoop({ root, adapter: scriptedAgent({ reviews: [{ pass: false, cause: "code_bug", fix_in: "acceptance_test" }] }), maxTasks: 1 });
    expect(r.reason, r.message).toBe("paused");
    expect(nodeSeq("T1")).toEqual([
      "N21:pass", "N22:pass", "N23:pass", "N24:pass", "N25:pass", "N26:pass", "N27:fail",
      "N22:pass", "N26:pass", "N27:pass", "N28:pass", "N29:pass",
    ]);
    const end27 = readEvents(root).events.find((e) => e.type === "node_end" && e.node === "N27" && e.result === "fail");
    expect(end27).toMatchObject({ cause: "code_bug", next: "N22", then: "N26" });
  });
});

describe("리뷰가 단위 테스트만 더하라고 할 때 (2026-11-27 실제 실행)", () => {
  it("fix_in이 unit_test면 N23에서 처음부터 통과하는 테스트를 더해도 받고, N27로 다시 간다", () => {
    const r = runLoop({ root, adapter: scriptedAgent({ reviews: [{ pass: false, cause: "code_bug", fix_in: "unit_test" }] }), maxTasks: 1 });
    expect(r.reason, r.message).toBe("paused");
    expect(nodeSeq("T1")).toEqual([
      "N21:pass", "N22:pass", "N23:pass", "N24:pass", "N25:pass", "N26:pass", "N27:fail",
      "N23:pass", "N27:pass", "N28:pass", "N29:pass",
    ]);
    expect(readEvents(root).events.find((e) => e.type === "node_end" && e.node === "N27" && e.result === "fail")).toMatchObject({ next: "N23", then: "N27" });
  });
});

describe("리뷰가 구조만 고치라고 할 때 (2026-11-25 오너 결정)", () => {
  it("fix_in이 structure면 N25 리팩터로 가서 고치고 N26으로 이어 간다", () => {
    const r = runLoop({ root, adapter: scriptedAgent({ reviews: [{ pass: false, cause: "code_bug", fix_in: "structure" }] }), maxTasks: 1 });
    expect(r.reason, r.message).toBe("paused");
    expect(nodeSeq("T1")).toEqual([
      "N21:pass", "N22:pass", "N23:pass", "N24:pass", "N25:pass", "N26:pass", "N27:fail",
      "N25:pass", "N26:pass", "N27:pass", "N28:pass", "N29:pass",
    ]);
    expect(readEvents(root).events.find((e) => e.type === "node_end" && e.node === "N27" && e.result === "fail")).toMatchObject({ next: "N25", then: "N26" });
  });
});
