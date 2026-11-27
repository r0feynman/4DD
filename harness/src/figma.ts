// Figma 연결 확인 (조각 3): 작업 세션처럼 Figma 서버 하나만 열고 whoami를 불러, 오너의 로그인이 이어지는지 본다.
//
// 작업 세션은 MCP를 모두 끄고(--strict-mcp-config) Figma 노드에만 오너가 등록·로그인한 서버(기본 figma-4dd)를 연다.
// 등록과 로그인은 도구마다 사람이 한 번 한다 (figmaSetupHint).

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor, childEnv, type Adapter, type FigmaAccess } from "./adapters.ts";
import type { Config } from "./config.ts";

export interface FigmaCheck {
  ok: boolean;
  handle?: string;
  plans?: string[];
  costUsd?: number;
  error?: string;
}

/** Codex의 엄격한 형식에도 맞게 모든 필드를 필수로 두고, 없을 수 있는 값은 null을 받는다 */
export const FIGMA_CHECK_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "whoami가 성공했는가" },
    handle: { type: ["string", "null"] },
    plans: { type: ["array", "null"], items: { type: "string" }, description: "플랜 이름과 시트, 예: 패스투웨이의 팀 (pro, Full)" },
    error: { type: ["string", "null"], description: "실패했으면 이유 (도구가 없음, 인증 필요 등)" },
  },
  required: ["ok", "handle", "plans", "error"],
  additionalProperties: false,
} as const;

export function figmaAccess(config: Config | undefined, level: "read" | "write"): FigmaAccess {
  return { level, server: config?.figma?.server ?? "figma-4dd", url: config?.figma?.url ?? "https://mcp.figma.com/mcp" };
}

/** 연결이 안 될 때 오너가 한 번 할 일. Claude와 Codex는 MCP 서버를 따로 등록하고 따로 로그인한다 */
export function figmaSetupHint(agent: "claude" | "codex", f: FigmaAccess): string {
  if (agent === "codex") return `오너가 한 번: codex mcp add ${f.server} --url ${f.url} 뒤 codex mcp login ${f.server}`;
  return `오너가 한 번: claude mcp add --scope user --transport http ${f.server} ${f.url} 뒤 claude의 /mcp에서 로그인`;
}

export function figmaCheck(root: string, config?: Config, adapter: Adapter = adapterFor("claude")): FigmaCheck {
  // 작업 세션과 같은 인자로 띄우려면 하네스 훅 설정 파일이 있어야 한다. 프로젝트가 아니면 빈 설정으로
  let dir = root;
  if (!existsSync(join(root, ".4dd", "hooks", "claude.json"))) {
    dir = mkdtempSync(join(tmpdir(), "4dd-figma-"));
    mkdirSync(join(dir, ".4dd", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".4dd", "hooks", "claude.json"), "{}\n");
  }
  const r = adapter.runTurn({
    root: dir,
    prompt: "Figma 도구 whoami를 한 번만 부르고, 정해진 형식으로 답하세요. 도구가 없거나 인증이 필요하면 ok를 false로 하고 이유를 적으세요. 다른 도구는 쓰지 마세요.",
    sessionId: null,
    env: childEnv({}) as Record<string, string>,
    timeoutMs: 180_000,
    readOnly: true,
    jsonSchema: FIGMA_CHECK_SCHEMA,
    figma: figmaAccess(config, "read"),
  });
  if (!r.ok) return { ok: false, error: r.error ?? "세션이 실패했습니다", ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
  const s = (r.structured ?? {}) as { ok?: boolean; handle?: string | null; plans?: string[] | null; error?: string | null };
  return {
    ok: !!s.ok,
    ...(s.handle ? { handle: s.handle } : {}),
    ...(s.plans ? { plans: s.plans } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
  };
}
