// 훅 입구. Claude 훅과 Codex 훅이 보내는 JSON을 읽어 잠금 검사(lock.ts)에 넘기고, 결과를 원장에 남긴다.
//
// 두 도구 모두 PreToolUse에서 종료 코드 2를 받으면 그 행동을 막고, stderr를 에이전트에게 보여 준다.
// 하네스가 띄운 세션에는 지휘 프로그램이 환경 변수로 지금 노드를 알려 준다.
//   FOURDD_ROOT       프로젝트 폴더
//   FOURDD_NODE       지금 노드 (N24 …)
//   FOURDD_NODE_RUN   지금 노드 실행 ID (NR88 …)
// 이 값이 없으면 하네스가 띄운 세션이 아니므로 아무것도 하지 않는다.

import { appendEvent, nextId, readEvents } from "./ledger.ts";
import { bashViolation, canSessionWrite } from "./lock.ts";
import { getNode, loadNodes, type NodeSet } from "./nodes.ts";

export type Tool = "claude" | "codex";

export interface HookCall {
  event: string;
  toolName: string | null;
  /** 고치려는 파일 (편집 도구일 때) */
  paths: string[];
  /** 셸 명령 (Bash일 때) */
  command: string | null;
  cwd: string | null;
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Codex apply_patch 패치에서 고치는 파일을 모두 뽑는다. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

function asCommand(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  return null;
}

export function parseHookPayload(tool: Tool, payload: Record<string, unknown>): HookCall {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : null;
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  const call: HookCall = {
    event: String(payload.hook_event_name ?? ""),
    toolName,
    paths: [],
    command: null,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
  };
  if (toolName === "Bash") {
    call.command = asCommand(input.command);
  } else if (tool === "claude" && toolName && CLAUDE_EDIT_TOOLS.has(toolName)) {
    const p = input.file_path ?? input.notebook_path;
    if (typeof p === "string") call.paths = [p];
  } else if (tool === "codex" && toolName === "apply_patch") {
    const patch = asCommand(input.command) ?? asCommand(input.input) ?? asCommand(input.patch) ?? "";
    call.paths = patchPaths(patch);
  }
  return call;
}

export interface HookResult {
  exitCode: 0 | 2;
  message: string;
}

/** 훅 한 번을 처리한다. 막아야 하면 종료 코드 2와 이유를 돌려준다. */
export function runHook(tool: Tool, payload: Record<string, unknown>, env: NodeJS.ProcessEnv, nodes: NodeSet = loadNodes()): HookResult {
  const nodeId = env.FOURDD_NODE;
  const runId = env.FOURDD_NODE_RUN ?? null;
  const call = parseHookPayload(tool, payload);
  const root = env.FOURDD_ROOT ?? call.cwd;
  if (!nodeId || !root) return { exitCode: 0, message: "" };
  const node = getNode(nodes, nodeId);
  const record = (check: "path" | "bash" | "session", target: string | undefined, result: "allowed" | "blocked") => {
    const { events } = readEvents(root);
    appendEvent(root, nodes.version, {
      type: "hook_run",
      id: nextId(events, "HR"),
      hook: `${tool}.${call.event === "SessionStart" ? "session_start" : "pre_tool"}`,
      check,
      run: runId,
      ...(target !== undefined ? { target } : {}),
      result,
    });
  };

  if (call.event === "SessionStart") {
    // 훅이 켜져 있다는 증거. 지휘 프로그램이 첫 차례 뒤에 이 줄이 있는지 본다.
    record("session", undefined, "allowed");
    return { exitCode: 0, message: "" };
  }

  if (call.command !== null) {
    const why = bashViolation(call.command);
    if (why) {
      record("bash", call.command.slice(0, 200), "blocked");
      return { exitCode: 2, message: `[4DD] ${why}` };
    }
    return { exitCode: 0, message: "" };
  }

  if (call.paths.length) {
    const blocked = call.paths.map((p) => canSessionWrite(root, node, p)).filter((d) => !d.allowed);
    record("path", call.paths.join(", ").slice(0, 300), blocked.length ? "blocked" : "allowed");
    if (blocked.length) return { exitCode: 2, message: `[4DD] ${blocked.map((d) => d.reason).join("\n[4DD] ")}` };
  }
  return { exitCode: 0, message: "" };
}
