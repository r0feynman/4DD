// 4dd setup codex: Codex 사용자 설정 폴더(~/.codex/hooks.json)에 4DD 훅을 한 번 넣는다.
//
// Codex는 신뢰하지 않은 프로젝트의 설정(.codex/hooks.json 포함)을 읽지 않는다. 하네스는 실행할 때마다 새 프로젝트 폴더를
// 만들기 때문에, 프로젝트마다 신뢰받는 대신 사용자 설정에 한 번 넣고 사람이 한 번 신뢰한다(/hooks).
// 이 훅은 하네스가 띄운 세션(FOURDD_NODE가 있을 때)에만 동작하고, 다른 Codex 세션에서는 아무것도 하지 않는다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookCommand } from "./init.ts";

export const CODEX_MARK = "check hook --tool codex";

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };
type HooksFile = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** 4DD 훅을 넣거나 고친다. 다른 훅은 그대로 둔다. 바뀐 것이 있으면 true. */
export function setupCodexHooks(home: string = codexHome()): { file: string; changed: boolean } {
  const file = join(home, "hooks.json");
  const data: HooksFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as HooksFile) : {};
  const before = JSON.stringify(data);
  const hooks = (data.hooks ??= {});
  const command = hookCommand(CODEX_MARK);
  const ours = (e: HookEntry) => e.hooks.some((h) => h.command.includes(CODEX_MARK));
  const put = (event: string, matcher?: string) => {
    const list = (hooks[event] ??= []).filter((e) => !ours(e));
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
    hooks[event] = list;
  };
  put("PreToolUse", "apply_patch|Bash");
  put("SessionStart");
  const after = JSON.stringify(data);
  if (after === before) return { file, changed: false };
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { file, changed: true };
}
