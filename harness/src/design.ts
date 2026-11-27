// 조각 3: 디자인 산출물의 형식과 관문 검사 (N00F 디자인 시스템, N03W 화면 상태, N03F 완성 화면).
//
//   design/tokens.json         Figma 변수를 옮긴 값 (color, space, font, radius). 앱 테마(mobile/theme.ts)는 이 파일을 그대로 가져다 씀
//   design/code-connect.json   기본 컴포넌트마다 Figma 노드와 코드 파일의 짝
//   specs/<기능>/states.md     화면 시나리오마다 다섯 상태(성공, 실패, 빈 상태, 로딩, 오류)의 와이어프레임, 또는 「화면 없음: 이유」
//   .feature의 「# figma: <node-id>」 시나리오의 끝 화면 프레임 (N03F가 시나리오 위에 붙임)
//
// Figma와 파일이 같은지는 리뷰 세션(L1)이 본다. 여기서는 파일끼리와 파일의 형식만 본다
// (Figma 변수를 읽는 REST API는 Enterprise 요금제에서만 되므로, 조각 3 명세 「구현하며 확인할 것」).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { featureFiles, readText } from "./plan.ts";
import { parseFeature } from "./trace.ts";

export const TOKENS_FILE = "design/tokens.json";
export const CODE_CONNECT_FILE = "design/code-connect.json";
export const THEME_FILE = "mobile/theme.ts";
export const TOKEN_GROUPS = ["color", "space", "font", "radius"] as const;
/** 디자인 시스템의 첫 컴포넌트 넷 (조각 3 정한 것: 최소로 시작) */
export const BASE_COMPONENTS = ["Button", "TextField", "Text", "Banner"] as const;
export const SCREEN_STATES = ["성공", "실패", "빈 상태", "로딩", "오류"] as const;
const FIGMA_NODE = /^\d+[:-]\d+$/;
const FIGMA_LINE = /^\s*#\s*figma:\s*(\S+)\s*$/;

export interface CheckResult {
  ok: boolean;
  detail: string;
}

/** N00F: 토큰 파일의 네 묶음이 있고, 앱 테마가 그 파일을 그대로 가져다 쓴다 (값이 둘로 갈라지지 않게) */
export function checkTokens(root: string): CheckResult {
  const text = readText(root, TOKENS_FILE);
  if (text === null) return { ok: false, detail: `${TOKENS_FILE}이 없습니다` };
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, detail: `${TOKENS_FILE}을 JSON으로 읽지 못했습니다: ${(e as Error).message}` };
  }
  const empty = TOKEN_GROUPS.filter((g) => !tokens[g] || typeof tokens[g] !== "object" || Object.keys(tokens[g] as object).length === 0);
  if (empty.length) return { ok: false, detail: `${TOKENS_FILE}에 비었거나 없는 묶음: ${empty.join(", ")} (${TOKEN_GROUPS.join(", ")}이 있어야 함)` };
  const theme = readText(root, THEME_FILE);
  if (theme === null) return { ok: false, detail: `${THEME_FILE}이 없습니다` };
  if (!/(from\s+|require\()\s*["'](\.\.\/)+design\/tokens\.json["']/.test(theme)) {
    return { ok: false, detail: `${THEME_FILE}이 ${TOKENS_FILE}을 가져다 쓰지 않습니다. 값을 옮겨 적지 말고 import로 씁니다 (Figma·토큰·테마의 값이 갈라지지 않게)` };
  }
  return { ok: true, detail: `토큰 ${TOKEN_GROUPS.length}묶음이 있고 ${THEME_FILE}이 ${TOKENS_FILE}을 씁니다` };
}

interface Mapping {
  component?: unknown;
  figma?: unknown;
  code?: unknown;
}

/** N00F: 기본 컴포넌트 넷이 모두 Figma 노드와 코드 파일에 이어져 있다 */
export function checkCodeConnect(root: string): CheckResult {
  const text = readText(root, CODE_CONNECT_FILE);
  if (text === null) return { ok: false, detail: `${CODE_CONNECT_FILE}이 없습니다` };
  let list: Mapping[];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return { ok: false, detail: `${CODE_CONNECT_FILE}은 [{component, figma, code}] 목록이어야 합니다` };
    list = parsed as Mapping[];
  } catch (e) {
    return { ok: false, detail: `${CODE_CONNECT_FILE}을 JSON으로 읽지 못했습니다: ${(e as Error).message}` };
  }
  const problems: string[] = [];
  for (const c of BASE_COMPONENTS) {
    const m = list.find((x) => x.component === c);
    if (!m) {
      problems.push(`${c}: 연결 없음`);
      continue;
    }
    if (typeof m.figma !== "string" || !FIGMA_NODE.test(m.figma)) problems.push(`${c}: Figma 노드 ID가 없거나 형식이 다름 (예: 12:34)`);
    if (typeof m.code !== "string" || !existsSync(join(root, m.code))) problems.push(`${c}: 코드 파일이 없음 (${String(m.code)})`);
  }
  return problems.length
    ? { ok: false, detail: `Code Connect 연결이 모자랍니다:\n  - ${problems.join("\n  - ")}` }
    : { ok: true, detail: `기본 컴포넌트 ${BASE_COMPONENTS.length}개가 Figma 노드와 코드 파일에 이어져 있습니다` };
}

export interface ScenarioStates {
  /** 화면이 없는 시나리오면 그 이유 */
  noScreen?: string;
  states: Map<string, string>;
}

/** states.md: 「## S15」 아래 「- 성공: …」 다섯 줄, 또는 「- 화면 없음: 이유」 */
export function parseStates(text: string): Map<string, ScenarioStates> {
  const out = new Map<string, ScenarioStates>();
  let cur: ScenarioStates | null = null;
  for (const line of text.split("\n")) {
    const h = /^##\s+(S\d+)\b/.exec(line);
    if (h) {
      cur = { states: new Map() };
      out.set(h[1], cur);
      continue;
    }
    const m = /^\s*-\s+([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (cur && m) {
      const key = m[1].trim();
      if (key === "화면 없음") cur.noScreen = m[2].trim();
      else cur.states.set(key, m[2].trim());
    }
  }
  return out;
}

/** 기능의 시나리오 ID (.feature 전부) */
function scenarioIds(root: string, feature: string): string[] {
  return featureFiles(root, feature).flatMap((f) => parseFeature(readText(root, f) ?? "", f).scenarios.map((s) => s.id));
}

/** 화면이 있는 시나리오 (states.md에서 「화면 없음」이 아닌 것) */
export function screenScenarios(root: string, feature: string): string[] {
  const states = parseStates(readText(root, `specs/${feature}/states.md`) ?? "");
  return scenarioIds(root, feature).filter((id) => !states.get(id)?.noScreen);
}

/** N03W: 모든 시나리오가 다섯 상태를 채웠거나 화면이 없다고 이유를 적었다 */
export function checkStates(root: string, feature: string): CheckResult {
  const file = `specs/${feature}/states.md`;
  const text = readText(root, file);
  if (text === null) return { ok: false, detail: `${file}이 없습니다` };
  const states = parseStates(text);
  const problems: string[] = [];
  for (const id of scenarioIds(root, feature)) {
    const s = states.get(id);
    if (!s) {
      problems.push(`${id}: 칸이 없음 (## ${id})`);
      continue;
    }
    if (s.noScreen !== undefined) {
      if (!s.noScreen) problems.push(`${id}: 화면 없음의 이유가 비었음`);
      continue;
    }
    const missing = SCREEN_STATES.filter((k) => !s.states.get(k));
    if (missing.length) problems.push(`${id}: 비었거나 없는 상태 ${missing.join(", ")} (해당 없으면 「해당 없음: 이유」)`);
  }
  return problems.length
    ? { ok: false, detail: `화면 상태가 모자랍니다:\n  - ${problems.join("\n  - ")}` }
    : { ok: true, detail: `시나리오 ${states.size}개의 화면 상태가 채워져 있습니다` };
}

/** .feature에서 시나리오마다 붙은 프레임 (「# figma: 12:345」 다음의 태그 줄) */
export function figmaFrames(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let pending: string | null = null;
  for (const line of text.split("\n")) {
    const m = FIGMA_LINE.exec(line);
    if (m) {
      pending = m[1];
      continue;
    }
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const tag = /@(S\d+)\b/.exec(line);
    if (pending && tag) out.set(tag[1], pending);
    pending = null;
  }
  return out;
}

const withoutFrames = (text: string) =>
  text
    .split("\n")
    .filter((l) => !FIGMA_LINE.test(l))
    .join("\n")
    .trim();

/** N03F: 화면 시나리오마다 프레임이 붙었고, 프레임 줄 말고는 시나리오를 바꾸지 않았다 */
export function checkFrames(root: string, feature: string): CheckResult {
  const problems: string[] = [];
  const screens = new Set(screenScenarios(root, feature));
  for (const file of featureFiles(root, feature)) {
    const text = readText(root, file) ?? "";
    const frames = figmaFrames(text);
    for (const s of parseFeature(text, file).scenarios) {
      if (!screens.has(s.id)) continue;
      const node = frames.get(s.id);
      if (!node) problems.push(`${s.id}: 프레임 줄이 없음 (시나리오 위에 「# figma: <node-id>」)`);
      else if (!FIGMA_NODE.test(node)) problems.push(`${s.id}: 프레임 노드 ID 형식이 다름 (${node}, 예: 12:345)`);
    }
    let before: string | null = null;
    try {
      before = git(root, ["show", `HEAD:${file}`]);
    } catch {
      before = null;
    }
    if (before !== null && withoutFrames(before) !== withoutFrames(text)) problems.push(`${file}: 프레임 줄 말고 시나리오가 바뀌었습니다. 시나리오는 N03에서만 고칩니다`);
  }
  return problems.length
    ? { ok: false, detail: `완성 화면 프레임이 모자랍니다:\n  - ${problems.join("\n  - ")}` }
    : { ok: true, detail: `화면 시나리오 ${screens.size}개에 프레임이 붙어 있습니다` };
}
