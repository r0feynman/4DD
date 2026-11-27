// 세션 노드 한 차례를 가짜 어댑터로 시험한다. 가짜 어댑터는 에이전트처럼 파일을 고치고, 훅처럼 원장에 줄을 남긴다.
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest, TurnResult } from "../src/adapters.ts";
import { loadConfig } from "../src/config.ts";
import { initProject } from "../src/init.ts";
import { appendEvent, eventsPath, nextId, readEvents } from "../src/ledger.ts";
import { loadNodes } from "../src/nodes.ts";
import { loadState } from "../src/state.ts";
import { runSessionNode } from "../src/turn.ts";

const harnessModules = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
const nodes = loadNodes();
let root = "";

const FAILING_S1 = `import { test, expect } from "vitest";\nimport { buildApp } from "../../src/app.ts";\ntest("S1", async () => { expect(typeof buildApp).toBe("function"); });\n`;

type Act = (req: TurnRequest) => void;

/** 에이전트 대신 act를 하고, 새 세션이면 세션 시작 훅처럼 원장에 한 줄을 남긴다. */
function fake(act: Act, opts: { hooks?: boolean; result?: Partial<TurnResult> } = {}): Adapter & { calls: TurnRequest[] } {
  const calls: TurnRequest[] = [];
  return {
    agent: "claude",
    calls,
    runTurn(req) {
      calls.push(req);
      if (opts.hooks !== false && req.sessionId === null) {
        const { events } = readEvents(req.root);
        appendEvent(req.root, nodes.version, { type: "hook_run", id: nextId(events, "HR"), hook: "claude.session_start", check: "session", run: req.env.FOURDD_NODE_RUN, result: "allowed" });
      }
      act(req);
      return { ok: true, sessionId: req.sessionId ?? "sess-1", text: "끝", tokens: { input: 100, output: 20, cached: 50 }, costUsd: 0.01, minutes: 0.5, turns: 3, timedOut: false, ...opts.result };
    },
  };
}

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const run = (adapter: Adapter, nodeId = "N22") => runSessionNode({ root, config: loadConfig(root), nodes, nodeId, task: "T1", adapter });
const lastEnd = () => readEvents(root).events.filter((e) => e.type === "node_end").at(-1);

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-turn-")), "proj");
  initProject(root, { install: false });
  symlinkSync(harnessModules, join(root, "node_modules"), "dir");
});

describe("세션 노드 한 차례", () => {
  it("에이전트가 시나리오의 인수 테스트를 쓰면 통과하고, 토큰·시간·세션을 남긴다", () => {
    const a = fake(() => put("tests/acceptance/S1.test.ts", FAILING_S1));
    const r = run(a);
    expect(r.passed).toBe(true);
    expect(a.calls[0].env).toMatchObject({ FOURDD_ROOT: root, FOURDD_NODE: "N22", FOURDD_NODE_RUN: r.runId });
    expect(a.calls[0].prompt).toContain("# N22 인수 테스트 작성");
    expect(lastEnd()).toMatchObject({ node: "N22", task: "T1", result: "pass", session: "sess-1", tokens: { input: 100, output: 20, cached: 50 }, cost_usd: 0.01, minutes: 0.5, turns: 3 });
    const end = lastEnd();
    expect(end && end.type === "node_end" && end.loaded[0]).toMatchObject({ kind: "instruction", id: "N22" });
    expect(loadState(root).state).toMatchObject({ task: "T1", session: "sess-1", node: "N22" });
  });

  it("관문을 못 채우면 실패하고, 다음 차례는 같은 세션을 이어 쓰며 지난 관문 결과를 받는다", () => {
    const first = fake(() => {}); // 아무것도 안 씀
    expect(run(first).passed).toBe(false);
    const second = fake(() => put("tests/acceptance/S1.test.ts", FAILING_S1));
    const r = run(second);
    expect(second.calls[0].sessionId).toBe("sess-1");
    expect(second.calls[0].prompt).toContain("### 지난 관문 결과");
    expect(second.calls[0].prompt).toContain("@S1");
    expect(r.passed).toBe(true);
  });

  it("고칠 수 없는 곳을 고치면 되돌리고 실패", () => {
    const a = fake(() => {
      put("tests/acceptance/S1.test.ts", FAILING_S1);
      put("src/app.ts", "export const buildApp = () => 1;\n");
      appendFileSync(join(root, "specs/login/spec.md"), "\n몰래 고침\n");
    });
    const r = run(a);
    expect(r.passed).toBe(false);
    expect(r.reverted).toEqual(["specs/login/spec.md", "src/app.ts"]);
    expect(existsSync(join(root, "src/app.ts"))).toBe(false);
    expect(r.summary).toContain("되돌렸습니다");
  });

  it("세션 시작 훅 기록이 없으면 훅이 꺼진 것으로 보고 멈춘다", () => {
    const r = run(fake(() => put("tests/acceptance/S1.test.ts", FAILING_S1), { hooks: false }));
    expect(r.stop).toContain("훅이 돌지 않았습니다");
    expect(r.passed).toBe(false);
    expect(lastEnd()).toMatchObject({ result: "wait" });
  });

  it("세션 동안 원장이 고쳐지면 멈춘다", () => {
    const r = run(fake(() => writeFileSync(eventsPath(root), "")));
    expect(r.stop).toContain("원장이 세션 동안 바뀌었습니다");
  });

  it("세션 오류나 시간 초과는 env", () => {
    const r = run(fake(() => {}, { result: { ok: false, timedOut: true, error: "차례 시간 제한을 넘었습니다" } }));
    expect(r).toMatchObject({ passed: false, cause: "env" });
    expect(lastEnd()).toMatchObject({ result: "fail", cause: "env" });
  });

  it("작업 세션 노드가 아니면 부르지 않는다", () => {
    expect(() => run(fake(() => {}), "N26")).toThrow(/작업 세션 노드가 아닙니다/);
  });
});

describe("리뷰의 고칠 곳 바로잡기 (조각 3, 2026-11-27 Codex 실제 실행)", () => {
  it("고른 노드가 지적한 파일을 하나도 못 고치면, 모두 고칠 수 있는 노드로 바꾼다", async () => {
    const { correctFixIn } = await import("../src/turn.ts");
    const nodes = loadNodes();
    const v = (fixIn: "behavior" | "structure" | "acceptance_test" | "unit_test", files: string[], why = "설계와 다름") =>
      ({ pass: false, cause: "code_bug" as const, fixIn, findings: files.map((file) => ({ file, line: 1, why })) });
    // tests/e2e의 파일 위치를 structure(N25)로 보냄 → N22
    expect(correctFixIn(v("structure", ["tests/e2e/android/lib/login-setup.js", "tests/e2e/web/lib/login-fixture.ts"]), nodes)).toBe("acceptance_test");
    // 하나라도 고칠 수 있으면 그대로 (남은 것은 다음 리뷰가 다시 잡음)
    expect(correctFixIn(v("structure", ["tests/e2e/web/lib/login-fixture.ts", "src/login-fixture.ts"]), nodes)).toBe("structure");
    // 동작을 고치라는데 단위 테스트 파일만 가리킴 → N23 (원장 경로처럼 절대 경로와 줄 번호가 붙어도)
    expect(correctFixIn(v("behavior", ["/p/tests/unit/app.test.ts:12"]), nodes, "/p")).toBe("unit_test");
    // 테스트가 없다는 지적은 테스트할 코드를 가리키기도 하므로 바로잡지 않는다
    expect(correctFixIn(v("unit_test", ["src/app.ts"]), nodes)).toBe("unit_test");
    expect(correctFixIn(v("acceptance_test", ["mobile/App.tsx"]), nodes)).toBe("acceptance_test");
    // 참고로만 적은 지적은 세지 않는다
    expect(correctFixIn(v("structure", ["tests/e2e/web/S1.spec.ts"], "참고: 위반 아님"), nodes)).toBe("structure");
  });
});
