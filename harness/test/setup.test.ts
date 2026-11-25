import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_MARK, setupCodexHooks } from "../src/setup.ts";

describe("4dd setup codex", () => {
  it("사용자 설정에 4DD 훅을 넣고, 다시 해도 겹치지 않는다", () => {
    const home = mkdtempSync(join(tmpdir(), "4dd-codex-"));
    expect(setupCodexHooks(home).changed).toBe(true);
    const data = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    expect(data.hooks.PreToolUse).toHaveLength(1);
    expect(data.hooks.PreToolUse[0].matcher).toBe("apply_patch|Bash");
    expect(data.hooks.PreToolUse[0].hooks[0].command).toContain(CODEX_MARK);
    expect(data.hooks.SessionStart[0].matcher).toBeUndefined();
    expect(setupCodexHooks(home).changed).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")).hooks.PreToolUse).toHaveLength(1);
  });

  it("오너가 원래 둔 다른 훅은 그대로 둔다", () => {
    const home = mkdtempSync(join(tmpdir(), "4dd-codex-"));
    const mine = { matcher: "^Bash$", hooks: [{ type: "command", command: "my-audit" }] };
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [mine] }, other: 1 }));
    setupCodexHooks(home);
    const data = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    expect(data.other).toBe(1);
    expect(data.hooks.PreToolUse[0]).toEqual(mine);
    expect(data.hooks.PreToolUse).toHaveLength(2);
  });
});
