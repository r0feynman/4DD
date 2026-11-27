import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHookPayload, patchPaths, runHook } from "../src/hooks.ts";
import { readEvents } from "../src/ledger.ts";
import { countFigmaCalls } from "../src/turn.ts";

describe("훅 입력 읽기", () => {
  it("Claude 편집 도구는 file_path를 읽는다", () => {
    const c = parseHookPayload("claude", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/p/src/a.ts", old_string: "a", new_string: "b" }, cwd: "/p" });
    expect(c).toMatchObject({ event: "PreToolUse", toolName: "Edit", paths: ["/p/src/a.ts"], command: null, cwd: "/p" });
    expect(parseHookPayload("claude", { hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: "/p/n.ipynb" } }).paths).toEqual(["/p/n.ipynb"]);
  });

  it("Bash는 명령을 읽는다 (Codex는 배열일 수도 있음)", () => {
    expect(parseHookPayload("claude", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }).command).toBe("git status");
    expect(parseHookPayload("codex", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: ["git", "commit", "-m", "x"] } }).command).toBe("git commit -m x");
  });

  it("Codex apply_patch는 패치 머리에서 파일을 모두 뽑는다", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-a",
      "+b",
      "*** Add File: tests/unit/lockout.test.ts",
      "+test",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch)).toEqual(["src/app.ts", "tests/unit/lockout.test.ts", "src/old.ts", "src/new.ts", "src/gone.ts"]);
    expect(parseHookPayload("codex", { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } }).paths).toHaveLength(5);
  });

  it("모르는 도구는 파일도 명령도 없다", () => {
    expect(parseHookPayload("claude", { hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query: "x" } })).toMatchObject({ paths: [], command: null });
  });
});

describe("Figma 도구 호출 세기 (조각 3)", () => {
  it("Figma MCP 도구는 막지 않고 원장에 남기고, 노드 실행별로 읽기·쓰기를 센다", () => {
    const root = mkdtempSync(join(tmpdir(), "4dd-hook-figma-"));
    const env = { FOURDD_ROOT: root, FOURDD_NODE: "N03F", FOURDD_NODE_RUN: "NR5", FOURDD_FEATURE: "login-screen" };
    const call = (tool: string, run = env) => runHook("claude", { hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} }, run);
    expect(call("mcp__figma-4dd__get_screenshot")).toEqual({ exitCode: 0, message: "" });
    call("mcp__figma-4dd__get_metadata");
    call("mcp__figma-4dd__use_figma");
    call("mcp__figma-4dd__get_screenshot", { ...env, FOURDD_NODE_RUN: "NR6" });
    call("WebSearch");
    const { events } = readEvents(root);
    expect(events.filter((e) => e.type === "hook_run").map((e) => (e.type === "hook_run" ? e.check : ""))).toEqual(["figma", "figma", "figma", "figma"]);
    expect(countFigmaCalls(events, "NR5")).toEqual({ read: 2, write: 1 });
    expect(countFigmaCalls(events, "NR6")).toEqual({ read: 1, write: 0 });
  });
});
