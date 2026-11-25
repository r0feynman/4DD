import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, eventsPath, LedgerError, nextId, readEvents } from "../src/ledger.ts";

const H = "0.1.0";
const project = () => mkdtempSync(join(tmpdir(), "4dd-ledger-"));

describe("원장 쓰기와 읽기", () => {
  it("쓴 이벤트를 그대로 읽고, 공통 필드를 채운다", () => {
    const root = project();
    appendEvent(root, H, { type: "run_start", run: "RUN1", agent: "claude", feature: "login" });
    appendEvent(root, H, { type: "node_start", id: "NR1", node: "N21", task: null, session: null });
    appendEvent(root, H, { type: "node_end", id: "NR1", node: "N21", task: "T1", result: "pass", minutes: 0 });
    const { events, warnings } = readEvents(root);
    expect(warnings).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["run_start", "node_start", "node_end"]);
    expect(events[0]).toMatchObject({ schema_version: 1, harness: H });
    expect(Date.parse(events[0].ts)).not.toBeNaN();
    const end = events[2];
    expect(end.type === "node_end" && end.loaded).toEqual([]);
  });

  it("한 줄에 이벤트 하나씩 추가만 한다", () => {
    const root = project();
    appendEvent(root, H, { type: "run_start", run: "RUN1", agent: "codex", feature: "login" });
    appendEvent(root, H, { type: "run_end", run: "RUN1", reason: "done" });
    const lines = readFileSync(eventsPath(root), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).reason).toBe("done");
  });

  it("형식이 틀린 이벤트는 쓰지 않는다", () => {
    const root = project();
    expect(() => appendEvent(root, H, { type: "classify", run: "NR1", node: "N26", cause: "typo" as never, by: "harness", needs_human: false })).toThrow(LedgerError);
    expect(() => appendEvent(root, H, { type: "node_start", id: "X1", node: "N21", task: null, session: null })).toThrow(/NR숫자/);
    expect(() => appendEvent(root, H, { type: "commit", sha: "a1b2c3d", node: "N24", task: "T1", extra: 1 } as never)).toThrow(LedgerError);
    expect(readEvents(root).events).toEqual([]);
  });

  it("내용 대신 ID와 해시만 남긴다: 지시문은 해시로", () => {
    const root = project();
    appendEvent(root, H, {
      type: "node_end",
      id: "NR3",
      node: "N24",
      task: "T1",
      result: "fail",
      cause: "code_bug",
      loaded: [{ kind: "instruction", id: "N24", hash: "3f1a" }],
      tokens: { input: 1200, output: 300 },
      minutes: 2.5,
      turns: 4,
    });
    const [e] = readEvents(root).events;
    expect(e.type === "node_end" && e.loaded[0]).toEqual({ kind: "instruction", id: "N24", hash: "3f1a" });
  });

  it("마지막 줄이 쓰다 끊겼으면 주의만 남기고 넘어간다", () => {
    const root = project();
    appendEvent(root, H, { type: "run_start", run: "RUN1", agent: "claude", feature: "login" });
    appendFileSync(eventsPath(root), '{"type":"node_st');
    const { events, warnings } = readEvents(root);
    expect(events).toHaveLength(1);
    expect(warnings[0]).toContain("마지막 줄");
  });

  it("중간 줄이 깨졌거나 더 새 하네스가 쓴 줄이면 멈춘다", () => {
    const broken = project();
    appendEvent(broken, H, { type: "run_start", run: "RUN1", agent: "claude", feature: "login" });
    appendFileSync(eventsPath(broken), "not json\n");
    appendEvent(broken, H, { type: "run_end", run: "RUN1", reason: "done" });
    expect(() => readEvents(broken)).toThrow(/2번째 줄이 JSON이 아닙니다/);

    const newer = project();
    appendEvent(newer, H, { type: "run_start", run: "RUN1", agent: "claude", feature: "login" });
    const line = JSON.stringify({ type: "run_end", ts: new Date().toISOString(), schema_version: 2, harness: H, run: "RUN1", reason: "done" });
    appendFileSync(eventsPath(newer), line + "\n");
    expect(() => readEvents(newer)).toThrow(/더 새 하네스/);
  });
});

describe("다음 ID", () => {
  it("종류마다 가장 큰 번호 다음을 준다", () => {
    const root = project();
    appendEvent(root, H, { type: "node_start", id: "NR1", node: "N21", task: null, session: null });
    appendEvent(root, H, { type: "node_start", id: "NR7", node: "N22", task: "T1", session: "s" });
    appendEvent(root, H, { type: "hook_run", id: "HR2", hook: "claude.pre_edit", check: "path", run: "NR7", target: "specs/login/spec.md", result: "blocked" });
    const { events } = readEvents(root);
    expect(nextId(events, "NR")).toBe("NR8");
    expect(nextId(events, "HR")).toBe("HR3");
    expect(nextId(events, "GR")).toBe("GR1");
    expect(nextId(events, "RUN")).toBe("RUN1");
  });
});
