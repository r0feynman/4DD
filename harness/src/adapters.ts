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

// ---------------------------------------------------------------- Claude

/** 작업 세션이 셸로 할 수 있는 것. 테스트를 돌리고 파일을 살펴보는 정도만 허용한다. */
export const CLAUDE_ALLOWED_BASH = ["npx vitest *", "npm test *", "npm test", "npm run *", "ls *", "ls", "cat *", "git status *", "git status", "git diff *", "git diff", "git log *"];

export function claudeArgs(req: TurnRequest, sessionId: string, resume: boolean): string[] {
  const args = ["-p", req.prompt, "--output-format", "json"];
  args.push(...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]));
  // 오너의 전역 설정(전역 훅, MCP 서버, 플러그인)이 하네스 세션에 섞이지 않게 한다. 하네스 훅은 --settings로 넣는다.
  args.push("--setting-sources", "project", "--settings", join(req.root, ".4dd", "hooks", "claude.json"));
  args.push("--strict-mcp-config", "--disable-slash-commands");
  if (req.readOnly) {
    args.push("--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk");
  } else {
    args.push("--tools", "Read,Edit,Write,Glob,Grep,Bash", "--permission-mode", "acceptEdits");
    args.push("--allowedTools", ...CLAUDE_ALLOWED_BASH.map((c) => `Bash(${c})`));
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
      ...(timedOut ? { error: "차례 시간 제한을 넘었습니다" } : parsed.error ? {} : r.status !== 0 ? { error: `claude 종료 코드 ${r.status}: ${(r.stderr ?? "").slice(0, 300)}` } : {}),
    };
  },
};

// ---------------------------------------------------------------- Codex

export function codexArgs(req: TurnRequest, schemaFile: string | null): string[] {
  const args = req.sessionId ? ["exec", "resume", req.sessionId] : ["exec"];
  args.push("--json");
  if (!req.sessionId) args.push("-C", req.root, "-s", req.readOnly ? "read-only" : "workspace-write");
  if (schemaFile) args.push("--output-schema", schemaFile);
  args.push(req.prompt);
  return args;
}

export function parseCodexOutput(stdout: string): Omit<TurnResult, "minutes" | "timedOut"> {
  let sessionId: string | null = null;
  let text = "";
  let input = 0;
  let output = 0;
  let cached = 0;
  let turns = 0;
  let sawUsage = false;
  let error: string | undefined;
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
    const r = spawnSync("codex", codexArgs(req, schemaFile), {
      cwd: req.root,
      encoding: "utf8",
      timeout: req.timeoutMs,
      env: childEnv(req.env),
      maxBuffer: 64 * 1024 * 1024,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const parsed = parseCodexOutput(r.stdout ?? "");
    return {
      ...parsed,
      sessionId: parsed.sessionId ?? req.sessionId,
      ok: parsed.ok && !timedOut,
      minutes: minutesSince(t0),
      timedOut,
      ...(timedOut ? { error: "차례 시간 제한을 넘었습니다" } : parsed.error ? {} : r.status !== 0 ? { error: `codex 종료 코드 ${r.status}: ${(r.stderr ?? "").slice(-300)}` } : {}),
    };
  },
};

export function adapterFor(agent: Agent): Adapter {
  return agent === "claude" ? claudeAdapter : codexAdapter;
}
