// 도구 어댑터: 세션 한 차례를 Claude나 Codex로 돌린다 (첫 구현 조각 명세 「도구 어댑터」).
//
// 지휘 프로그램은 도구를 몰라도 되게 runTurn 하나만 부른다. 같은 작업 안에서는 세션을 이어 쓴다.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Agent = "claude" | "codex";

export interface TurnRequest {
  root: string;
  prompt: string;
  /** 이어 쓸 세션. 없으면 새 세션 */
  sessionId: string | null;
  /** 훅에 지금 노드를 알려 주는 환경 변수 (FOURDD_ROOT, FOURDD_NODE, FOURDD_NODE_RUN) */
  env: Record<string, string>;
  timeoutMs: number;
  /** 리뷰 세션: 파일을 고칠 수 없다 */
  readOnly?: boolean;
  /** 정해진 출력 형식 (리뷰, 실패 원인 분류) */
  jsonSchema?: object;
  /** 이 차례에 Figma를 연다 (조각 3). 노드의 figma 값과 설정의 서버. 없으면 MCP를 모두 끈다 */
  figma?: FigmaAccess;
}

export interface FigmaAccess {
  level: "read" | "write";
  /** 오너가 Claude Code에 등록·로그인한 Figma MCP 서버 이름 (로그인이 이 이름으로 이어짐) */
  server: string;
  url: string;
}

/** 읽기 노드(N13, N22~N27, 리뷰 세션)가 쓰는 Figma 도구 */
export const FIGMA_READ_TOOLS = [
  "whoami", "get_metadata", "get_screenshot", "get_design_context", "get_variable_defs", "get_code_connect_map",
  "get_figma_skill", "search_design_system", "download_assets", "get_libraries", "create_session",
];
/** 디자인 노드(N00F, N03W, N03F)만 더 쓰는 Figma 도구 (그리기, 파일 만들기, Code Connect) */
export const FIGMA_WRITE_TOOLS = ["use_figma", "create_new_file", "add_code_connect_map", "send_code_connect_mappings", "upload_assets"];

export function figmaTools(f: FigmaAccess): string[] {
  const names = f.level === "write" ? [...FIGMA_READ_TOOLS, ...FIGMA_WRITE_TOOLS] : FIGMA_READ_TOOLS;
  return names.map((n) => `mcp__${f.server}__${n}`);
}

export interface TurnResult {
  ok: boolean;
  sessionId: string | null;
  text: string;
  structured?: unknown;
  tokens?: { input: number; output: number; cached?: number };
  costUsd?: number;
  minutes: number;
  turns?: number;
  timedOut: boolean;
  error?: string;
  /** Figma 도구 호출 수 (Codex는 출력에서 셈. Claude는 훅이 원장에 남김) */
  figmaCalls?: { read: number; write: number };
}

export interface Adapter {
  agent: Agent;
  runTurn(req: TurnRequest): TurnResult;
}

/** 하위 에이전트에 넘길 환경. 이 하네스를 띄운 도구(Claude Code 등)의 환경 변수가 새지 않게 뺀다. */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_|VITEST)/.test(k)));
  return { ...clean, ...extra };
}

const minutesSince = (t0: number) => Math.round(((Date.now() - t0) / 60_000) * 100) / 100;

/** 명령을 띄우지도 못했으면(명령 없음, 인자가 너무 김) 그 이유. 결과 JSON이 없다는 말만으로는 원인을 알 수 없다 */
function spawnError(cmd: string, r: { error?: Error }): { error: string } | undefined {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (!r.error || code === "ETIMEDOUT") return undefined;
  return { error: `${cmd}를 띄우지 못했습니다 (${code ?? r.error.message})` };
}

// ---------------------------------------------------------------- Claude

/** 작업 세션이 셸로 할 수 있는 것. 테스트를 돌리고 파일을 살펴보는 정도만 허용한다. */
export const CLAUDE_ALLOWED_BASH = ["npx vitest *", "npm test *", "npm test", "npm run *", "ls *", "ls", "cat *", "git status *", "git status", "git diff *", "git diff", "git log *"];

/**
 * 지시문은 인자가 아니라 표준 입력으로 넘긴다 (조각 3, 2026-11-27 실제 실행: 큰 작업의 리뷰 지시문이 141KB가 되자
 * Linux가 인자 하나를 128KB까지만 받아 명령이 뜨지 못했다). 그래서 인자에는 지시문이 없다
 */
export function claudeArgs(req: TurnRequest, sessionId: string, resume: boolean): string[] {
  const args = ["-p", "--output-format", "json"];
  args.push(...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]));
  // 오너의 전역 설정(전역 훅, MCP 서버, 플러그인)이 하네스 세션에 섞이지 않게 한다. 하네스 훅은 --settings로 넣는다.
  args.push("--setting-sources", "project", "--settings", join(req.root, ".4dd", "hooks", "claude.json"));
  args.push("--strict-mcp-config", "--disable-slash-commands");
  // Figma를 쓰는 노드만 오너가 로그인해 둔 Figma 서버 하나를 연다 (조각 3). 다른 MCP와 사용자 훅은 그대로 꺼져 있다
  if (req.figma) args.push("--mcp-config", JSON.stringify({ mcpServers: { [req.figma.server]: { type: "http", url: req.figma.url } } }));
  const figma = req.figma ? figmaTools(req.figma) : [];
  if (req.readOnly) {
    args.push("--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk");
    if (figma.length) args.push("--allowedTools", ...figma);
  } else {
    args.push("--tools", "Read,Edit,Write,Glob,Grep,Bash", "--permission-mode", "acceptEdits");
    // Figma 도구가 주는 짧은 다운로드 주소로 프레임 이미지를 받으려고 curl을 연다 (N03F)
    const bash = req.figma ? [...CLAUDE_ALLOWED_BASH, "curl *"] : CLAUDE_ALLOWED_BASH;
    args.push("--allowedTools", ...bash.map((c) => `Bash(${c})`), ...figma);
    args.push("--disallowedTools", "Bash(git commit *)", "Bash(git push *)");
  }
  if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
  return args;
}

export function parseClaudeOutput(stdout: string): Omit<TurnResult, "minutes" | "timedOut"> {
  const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) return { ok: false, sessionId: null, text: "", error: "Claude 결과 JSON이 없습니다" };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, sessionId: null, text: "", error: "Claude 결과를 JSON으로 읽지 못했습니다" };
  }
  const u = (j.usage ?? {}) as Record<string, number>;
  const tokens = j.usage
    ? { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0 }
    : undefined;
  return {
    ok: j.is_error === false && j.subtype === "success",
    sessionId: typeof j.session_id === "string" ? j.session_id : null,
    text: typeof j.result === "string" ? j.result : "",
    ...(j.structured_output !== undefined ? { structured: j.structured_output } : {}),
    ...(tokens ? { tokens } : {}),
    ...(typeof j.total_cost_usd === "number" ? { costUsd: j.total_cost_usd } : {}),
    ...(typeof j.num_turns === "number" ? { turns: j.num_turns } : {}),
    ...(j.is_error ? { error: `Claude 오류: ${String(j.subtype ?? "")} ${String(j.result ?? "").slice(0, 300)}` } : {}),
  };
}

export const claudeAdapter: Adapter = {
  agent: "claude",
  runTurn(req) {
    const t0 = Date.now();
    const resume = req.sessionId !== null;
    const sessionId = req.sessionId ?? randomUUID();
    const r = spawnSync("claude", claudeArgs(req, sessionId, resume), {
      cwd: req.root,
      encoding: "utf8",
      input: req.prompt,
      timeout: req.timeoutMs,
      env: childEnv(req.env),
      maxBuffer: 64 * 1024 * 1024,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const parsed = parseClaudeOutput(r.stdout ?? "");
    return {
      ...parsed,
      sessionId: parsed.sessionId ?? sessionId,
      ok: parsed.ok && !timedOut,
      minutes: minutesSince(t0),
      timedOut,
      ...(timedOut ? { error: "차례 시간 제한을 넘었습니다" } : spawnError("claude", r) ?? (parsed.error ? {} : r.status !== 0 ? { error: `claude 종료 코드 ${r.status}: ${(r.stderr ?? "").slice(0, 300)}` } : {})),
    };
  },
};

// ---------------------------------------------------------------- Codex

/**
 * Codex 세션의 MCP 설정 덮어쓰기 (조각 3). Claude의 --strict-mcp-config처럼 사용자가 등록한 서버를 모두 끄고,
 * Figma 노드에만 오너가 `codex mcp add`·`codex mcp login`한 Figma 서버를 그 노드의 도구로만 연다.
 * 디자인 노드는 프레임 이미지를 curl로 받으므로 작업 폴더 샌드박스의 네트워크를 연다.
 */
export function codexMcpOverrides(req: TurnRequest, servers: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of servers) if (name !== req.figma?.server) out.push("-c", `mcp_servers.${name}.enabled=false`);
  if (req.figma) {
    const tools = figmaTools(req.figma).map((t) => `"${t.split("__").at(-1)}"`);
    out.push("-c", `mcp_servers.${req.figma.server}.enabled=true`, "-c", `mcp_servers.${req.figma.server}.enabled_tools=[${tools.join(", ")}]`);
    if (req.figma.level === "write" && !req.readOnly) out.push("-c", "sandbox_workspace_write.network_access=true");
  }
  return out;
}

export function codexArgs(req: TurnRequest, schemaFile: string | null, servers: readonly string[] = []): string[] {
  const args = req.sessionId ? ["exec", "resume", req.sessionId] : ["exec"];
  args.push("--json");
  if (!req.sessionId) args.push("-C", req.root, "-s", req.readOnly ? "read-only" : "workspace-write");
  if (schemaFile) args.push("--output-schema", schemaFile);
  args.push(...codexMcpOverrides(req, servers));
  // 지시문은 표준 입력으로 (「-」). 인자 하나는 128KB까지라 큰 지시문이면 명령이 뜨지 못한다
  args.push("-");
  return args;
}

let codexServers: string[] | null = null;
/** 사용자가 Codex에 등록한 MCP 서버 이름 (한 번 읽어 둠). 못 읽으면 빈 목록 */
export function codexMcpServers(): string[] {
  if (codexServers) return codexServers;
  const r = spawnSync("codex", ["mcp", "list", "--json"], { encoding: "utf8", timeout: 30_000, env: childEnv({}) });
  try {
    const list = JSON.parse(r.stdout ?? "[]") as { name?: unknown }[];
    codexServers = list.map((x) => x.name).filter((n): n is string => typeof n === "string" && /^[A-Za-z0-9_-]+$/.test(n));
  } catch {
    codexServers = [];
  }
  return codexServers;
}

export function parseCodexOutput(stdout: string, figmaServer?: string): Omit<TurnResult, "minutes" | "timedOut"> {
  let sessionId: string | null = null;
  let text = "";
  let input = 0;
  let output = 0;
  let cached = 0;
  let turns = 0;
  let sawUsage = false;
  let error: string | undefined;
  const figma = { read: 0, write: 0 };
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type === "thread.started" && typeof e.thread_id === "string") sessionId = e.thread_id;
    if (e.type === "turn.completed") {
      turns++;
      const u = (e.usage ?? {}) as Record<string, number>;
      sawUsage = true;
      input += u.input_tokens ?? 0;
      cached += u.cached_input_tokens ?? 0;
      output += u.output_tokens ?? 0;
    }
    if (e.type === "item.completed") {
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") text = item.text;
      if (item.type === "mcp_tool_call" && figmaServer && item.server === figmaServer) figma[FIGMA_WRITE_TOOLS.includes(String(item.tool)) ? "write" : "read"]++;
    }
    if (e.type === "turn.failed" || e.type === "error") {
      const msg = (e.error as { message?: string } | undefined)?.message ?? (e.message as string | undefined) ?? "";
      error = `Codex 오류: ${msg.slice(0, 300)}`;
    }
  }
  let structured: unknown;
  try {
    structured = text ? JSON.parse(text) : undefined;
  } catch {
    structured = undefined;
  }
  return {
    ok: !error && turns > 0,
    sessionId,
    text,
    ...(structured !== undefined ? { structured } : {}),
    // Codex의 input_tokens에는 캐시에서 읽은 토큰이 들어 있다.
    ...(sawUsage ? { tokens: { input: input - cached, output, cached } } : {}),
    ...(turns ? { turns } : {}),
    ...(error ? { error } : {}),
    ...(figma.read + figma.write ? { figmaCalls: figma } : {}),
  };
}

export const codexAdapter: Adapter = {
  agent: "codex",
  runTurn(req) {
    const t0 = Date.now();
    let schemaFile: string | null = null;
    if (req.jsonSchema) {
      schemaFile = join(mkdtempSync(join(tmpdir(), "4dd-schema-")), "schema.json");
      writeFileSync(schemaFile, JSON.stringify(req.jsonSchema));
    }
    const r = spawnSync("codex", codexArgs(req, schemaFile, codexMcpServers()), {
      cwd: req.root,
      encoding: "utf8",
      input: req.prompt,
      timeout: req.timeoutMs,
      env: childEnv(req.env),
      maxBuffer: 64 * 1024 * 1024,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const parsed = parseCodexOutput(r.stdout ?? "", req.figma?.server);
    return {
      ...parsed,
      sessionId: parsed.sessionId ?? req.sessionId,
      ok: parsed.ok && !timedOut,
      minutes: minutesSince(t0),
      timedOut,
      ...(timedOut ? { error: "차례 시간 제한을 넘었습니다" } : spawnError("codex", r) ?? (parsed.error ? {} : r.status !== 0 ? { error: `codex 종료 코드 ${r.status}: ${(r.stderr ?? "").slice(-300)}` } : {})),
    };
  },
};

export function adapterFor(agent: Agent): Adapter {
  return agent === "claude" ? claudeAdapter : codexAdapter;
}
