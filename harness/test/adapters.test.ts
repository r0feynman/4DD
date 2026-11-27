import { describe, expect, it } from "vitest";
import { childEnv, claudeArgs, codexArgs, parseClaudeOutput, parseCodexOutput, type TurnRequest } from "../src/adapters.ts";

const req: TurnRequest = { root: "/p", prompt: "할 일", sessionId: null, env: { FOURDD_NODE: "N22" }, timeoutMs: 1000 };

describe("Claude 어댑터", () => {
  it("새 세션은 --session-id, 이어 쓰기는 --resume", () => {
    const a = claudeArgs(req, "u-1", false);
    expect(a.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(a).not.toContain("할 일"); // 지시문은 표준 입력으로 (인자 하나는 128KB까지)
    expect(a).toContain("--session-id");
    expect(claudeArgs(req, "u-1", true)).toContain("--resume");
  });

  it("오너의 전역 설정을 빼고 하네스 훅만 넣는다", () => {
    const a = claudeArgs(req, "u-1", false);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("project");
    expect(a[a.indexOf("--settings") + 1]).toBe("/p/.4dd/hooks/claude.json");
    expect(a).toEqual(expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands"]));
    expect(a).toContain("Bash(git commit *)");
  });

  it("리뷰 세션은 읽기 도구만, 정해진 출력 형식", () => {
    const a = claudeArgs({ ...req, readOnly: true, jsonSchema: { type: "object" } }, "u-1", false);
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(a[a.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(a).not.toContain("--allowedTools");
  });

  it("결과 JSON에서 세션, 토큰, 가격, 차례 수를 읽는다", () => {
    const out = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s-9",
      result: "S1 인수 테스트를 썼습니다",
      num_turns: 6,
      total_cost_usd: 0.21,
      usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 300 },
    });
    expect(parseClaudeOutput(`경고 한 줄\n${out}\n`)).toEqual({
      ok: true,
      sessionId: "s-9",
      text: "S1 인수 테스트를 썼습니다",
      tokens: { input: 2010, output: 300, cached: 5000 },
      costUsd: 0.21,
      turns: 6,
    });
  });

  it("오류 결과", () => {
    const r = parseClaudeOutput(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", result: "" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("error_max_turns");
    expect(parseClaudeOutput("").ok).toBe(false);
  });
});

describe("Codex 어댑터", () => {
  it("새 세션은 폴더와 샌드박스를 주고, 이어 쓰기는 resume", () => {
    expect(codexArgs(req, null)).toEqual(["exec", "--json", "-C", "/p", "-s", "workspace-write", "-"]);
    expect(codexArgs({ ...req, sessionId: "t-1" }, null)).toEqual(["exec", "resume", "t-1", "--json", "-"]);
    expect(codexArgs({ ...req, readOnly: true }, "/tmp/s.json")).toEqual(["exec", "--json", "-C", "/p", "-s", "read-only", "--output-schema", "/tmp/s.json", "-"]);
  });

  it("사용자가 등록한 MCP 서버를 모두 끄고, Figma 노드에만 Figma 서버를 그 노드의 도구로 연다 (조각 3)", () => {
    const servers = ["context7", "notion", "figma-4dd"];
    const plain = codexArgs(req, null, servers);
    expect(plain.slice(-7)).toEqual(["-c", "mcp_servers.context7.enabled=false", "-c", "mcp_servers.notion.enabled=false", "-c", "mcp_servers.figma-4dd.enabled=false", "-"]);
    const draw = codexArgs({ ...req, figma: { level: "write", server: "figma-4dd", url: "https://mcp.figma.com/mcp" } }, null, servers);
    expect(draw).toContain("mcp_servers.notion.enabled=false");
    expect(draw).not.toContain("mcp_servers.figma-4dd.enabled=false");
    expect(draw).toContain("mcp_servers.figma-4dd.enabled=true");
    const tools = draw.find((a) => a.startsWith("mcp_servers.figma-4dd.enabled_tools="))!;
    expect(tools).toContain('"use_figma"');
    expect(tools).toContain('"download_assets"');
    expect(draw).toContain("sandbox_workspace_write.network_access=true"); // 프레임 이미지를 curl로 받음
    const look = codexArgs({ ...req, readOnly: true, figma: { level: "read", server: "figma-4dd", url: "https://mcp.figma.com/mcp" } }, null, servers);
    expect(look.find((a) => a.startsWith("mcp_servers.figma-4dd.enabled_tools="))).not.toContain('"use_figma"');
    expect(look).not.toContain("sandbox_workspace_write.network_access=true");
  });

  it("Figma 서버의 도구 호출을 읽기·쓰기로 센다", () => {
    const lines = [
      { type: "thread.started", thread_id: "t-8" },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "figma-4dd", tool: "get_screenshot", status: "completed" } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "figma-4dd", tool: "use_figma", status: "completed" } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "other", tool: "x", status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
    ].map((e) => JSON.stringify(e));
    expect(parseCodexOutput(lines.join("\n"), "figma-4dd").figmaCalls).toEqual({ read: 1, write: 1 });
    expect(parseCodexOutput(lines.join("\n")).figmaCalls).toBeUndefined();
  });

  it("JSONL 이벤트에서 세션, 마지막 메시지, 토큰을 읽는다", () => {
    const lines = [
      { type: "thread.started", thread_id: "t-7" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "command_execution", command: "npx vitest" } },
      { type: "item.completed", item: { type: "agent_message", text: '{"pass":true}' } },
      { type: "turn.completed", usage: { input_tokens: 9000, cached_input_tokens: 6000, output_tokens: 400 } },
    ].map((e) => JSON.stringify(e));
    expect(parseCodexOutput(lines.join("\n"))).toEqual({
      ok: true,
      sessionId: "t-7",
      text: '{"pass":true}',
      structured: { pass: true },
      tokens: { input: 3000, output: 400, cached: 6000 },
      turns: 1,
    });
  });

  it("실패 이벤트", () => {
    const r = parseCodexOutput(JSON.stringify({ type: "turn.failed", error: { message: "usage limit" } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage limit");
  });
});

describe("하위 에이전트 환경", () => {
  it("하네스를 띄운 도구의 환경 변수는 빼고 노드 정보를 넣는다", () => {
    process.env.CLAUDE_CODE_SIMPLE = "1";
    process.env.ANTHROPIC_BASE_URL = "http://x";
    const env = childEnv({ FOURDD_NODE: "N22" });
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.FOURDD_NODE).toBe("N22");
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe("Figma를 여는 차례 (조각 3)", () => {
  const base: TurnRequest = { root: "/p", prompt: "x", sessionId: null, env: {}, timeoutMs: 1000 };
  const figma = { server: "figma-4dd", url: "https://mcp.figma.com/mcp" };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("Figma가 없는 노드는 MCP를 모두 끈 채 그대로", () => {
    const a = claudeArgs(base, "u", false);
    expect(a).toContain("--strict-mcp-config");
    expect(a).not.toContain("--mcp-config");
    expect(a.join(" ")).not.toContain("mcp__");
    expect(a.join(" ")).not.toContain("curl");
  });

  it("디자인 노드(write)는 Figma 서버 하나만 열고 그리기 도구와 curl까지 허용", () => {
    const a = claudeArgs({ ...base, figma: { level: "write", ...figma } }, "u", false);
    expect(a).toContain("--strict-mcp-config");
    expect(JSON.parse(after(a, "--mcp-config"))).toEqual({ mcpServers: { "figma-4dd": { type: "http", url: "https://mcp.figma.com/mcp" } } });
    expect(a).toContain("mcp__figma-4dd__use_figma");
    expect(a).toContain("mcp__figma-4dd__download_assets");
    expect(a).toContain("Bash(curl *)");
  });

  it("읽기 노드와 리뷰 세션은 그리기 도구가 없다 (G10: 구현이 디자인을 바꾸지 못함)", () => {
    const work = claudeArgs({ ...base, figma: { level: "read", ...figma } }, "u", false);
    expect(work).toContain("mcp__figma-4dd__get_design_context");
    expect(work).not.toContain("mcp__figma-4dd__use_figma");
    const review = claudeArgs({ ...base, readOnly: true, figma: { level: "read", ...figma } }, "u", false);
    expect(review).toContain("mcp__figma-4dd__get_screenshot");
    expect(review).not.toContain("mcp__figma-4dd__use_figma");
    expect(review).not.toContain("Bash(curl *)");
  });
});

describe("Figma 연결 확인 안내", () => {
  it("도구마다 등록·로그인 명령이 다르다", async () => {
    const { figmaSetupHint } = await import("../src/figma.ts");
    const f = { level: "read" as const, server: "figma-4dd", url: "https://mcp.figma.com/mcp" };
    expect(figmaSetupHint("codex", f)).toBe("오너가 한 번: codex mcp add figma-4dd --url https://mcp.figma.com/mcp 뒤 codex mcp login figma-4dd");
    expect(figmaSetupHint("claude", f)).toContain("claude mcp add --scope user --transport http figma-4dd https://mcp.figma.com/mcp");
  });

  it("확인 형식은 Codex의 엄격한 형식에 맞는다 (모든 필드 필수, 다른 필드 없음)", async () => {
    const { FIGMA_CHECK_SCHEMA: s } = await import("../src/figma.ts");
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
  });
});
