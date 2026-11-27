// 4dd context: 세션에 보낼 지시문과 「이번 작업」을 모은다 (하네스 설계 ② 「에이전트가 노드 하나를 처리하는 순서」).
//
// 파일 전체가 아니라 ID로 찾은 조각만 넣는다. 원장에는 넣은 지시문의 ID와 해시만 남긴다(loaded).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { CODE_CONNECT_FILE, FRAMES_DIR, THEME_FILE, TOKENS_FILE } from "./design.ts";
import { taskPlatforms, taskStartRef, GATE_DIR } from "./gate.ts";
import { git } from "./git.ts";
import { globsText } from "./glob.ts";
import { DIR, readEvents, type LedgerEvent } from "./ledger.ts";
import { getNode, instructionPath, resolveWrites, type NodeDef, type NodeSet } from "./nodes.ts";
import { e2eFile, featureFiles, featureIds, featurePath, readSprint, readText, SPRINT_FILE } from "./plan.ts";
import { checkProject, featureNames, nextIds, parseSpec, parseTasks, scenariosForTask, type FeatureTrace } from "./trace.ts";

export const HUMAN_DIR = `${DIR}/human`;

export interface Loaded {
  kind: "instruction" | "skill" | "learning" | "file";
  id: string;
  hash?: string;
}

export interface BuiltContext {
  prompt: string;
  loaded: Loaded[];
}

const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

function featureOf(root: string, task: string): FeatureTrace | undefined {
  return checkProject(root).find((t) => t.tasks.some((x) => x.id === task));
}

/** .feature에서 배경과 시나리오 블록(위의 태그 줄 포함)을 잘라 낸다. */
export function scenarioBlocks(text: string, ids: string[]): string {
  const lines = text.split(/\r?\n/);
  const isTag = (l: string) => l.trim().startsWith("@");
  const isScenario = (l: string) => /^\s*(시나리오 개요|시나리오|Scenario Outline|Scenario Template|Scenario|Example)\s*:/.test(l);
  const starts: { start: number; id: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isScenario(lines[i])) continue;
    let s = i;
    while (s > 0 && (isTag(lines[s - 1]) || lines[s - 1].trim().startsWith("#"))) s--;
    const tags = lines.slice(s, i).join(" ");
    const m = /@(S\d+)\b/.exec(tags);
    starts.push({ start: s, id: m ? m[1] : null });
  }
  const out: string[] = [];
  const bg = lines.findIndex((l) => /^\s*(배경|Background)\s*:/.test(l));
  if (bg >= 0) {
    const end = starts.find((x) => x.start > bg)?.start ?? lines.length;
    out.push(lines.slice(bg, end).join("\n").trimEnd());
  }
  starts.forEach((x, k) => {
    if (x.id && ids.includes(x.id)) {
      const end = starts[k + 1]?.start ?? lines.length;
      out.push(lines.slice(x.start, end).join("\n").trimEnd());
    }
  });
  return out.join("\n\n");
}

function lastFor<T extends LedgerEvent["type"]>(events: LedgerEvent[], type: T, pred: (e: Extract<LedgerEvent, { type: T }>) => boolean) {
  return events.filter((e): e is Extract<LedgerEvent, { type: T }> => e.type === type && pred(e as Extract<LedgerEvent, { type: T }>)).at(-1);
}

export interface ContextOptions {
  root: string;
  nodes: NodeSet;
  nodeId: string;
  /** Stage 2의 작업. Stage 0·1에서는 null (Stage 2에서 돌아온 경우에는 원래 작업) */
  task: string | null;
  /** 지금 기능 폴더 이름 (조각 2) */
  feature?: string | null;
  /** 지시문 대신 쓸 파일 (nodes.yaml 기준 경로): 관문의 리뷰 세션 (N13, N14) */
  instruction?: string;
  /** 읽기 전용 리뷰 세션 */
  readOnly?: boolean;
}

export function buildContext(opts: ContextOptions): BuiltContext {
  const { root, nodes, nodeId, task } = opts;
  const feature = opts.feature ?? null;
  const node = getNode(nodes, nodeId);
  const loaded: Loaded[] = [];
  const parts: string[] = [];

  const unit = task ? `작업 ${task}` : `기능 ${feature ?? "-"}`;
  parts.push(`# 4DD 하네스 · ${node.id} ${node.name}${opts.readOnly ? " (리뷰)" : ""} · ${unit}`);
  const resolved = resolveWrites(node, feature);
  const writes = !opts.readOnly && resolved.length ? globsText(resolved) : "없음 (읽기 전용)";
  parts.push(
    [
      "당신은 4DD 하네스가 띄운 세션입니다. 이번 차례에는 아래 노드 하나만 처리하고 끝냅니다.",
      "- 다음 노드로 넘어가거나 관문을 판정하지 않습니다. 끝나면 하네스가 관문을 돌립니다.",
      `- 이 노드에서 고칠 수 있는 곳: ${writes}. 다른 곳을 고치려 하면 막히고, 고쳐도 하네스가 되돌립니다.`,
      "- 커밋하지 않습니다. 하네스가 합니다.",
      ...(opts.readOnly ? ["- 지적(why)은 한국어로 씁니다. PO가 검토 페이지에서, 사람이 회고에서 읽습니다."] : []),
      ...(node.stage >= 2 ? ["- 테스트는 `npx vitest run <파일>`로 직접 돌려 봐도 됩니다."] : ["- 사람 명령(4dd human, story, review)은 쓰지 않습니다. 승인은 PO가 합니다."]),
    ].join("\n"),
  );

  const ipath = opts.instruction ? join(nodes.dir, opts.instruction) : instructionPath(nodes, nodeId);
  if (ipath) {
    const text = readFileSync(ipath, "utf8");
    parts.push(text.trim());
    loaded.push({ kind: "instruction", id: opts.instruction ? `${nodeId}.review` : nodeId, hash: shortHash(text) });
  }

  if (node.stage < 2) {
    if (!feature) throw new Error(`${nodeId}: 어느 기능의 노드인지 모릅니다`);
    parts.push(planWork(root, node, feature, task).join("\n\n"));
    return { prompt: parts.join("\n\n") + "\n", loaded };
  }
  if (!task) throw new Error(`${nodeId}: 작업 없이 Stage 2 노드의 맥락을 만들 수 없습니다`);

  const trace = featureOf(root, task);
  const t = trace?.tasks.find((x) => x.id === task);
  const work: string[] = ["## 이번 작업"];
  if (trace && t) {
    const scen = scenariosForTask(trace, task);
    const reqIds = [...new Set([...t.reqs, ...scen.flatMap((s) => s.reqs)])];
    if (node.reads.includes("task")) {
      work.push(`### 작업 (${trace.dir}/tasks.md)\n- ${t.id} ${t.title} (${t.reqs.join(", ")})`);
      work.push(scen.length ? `이 작업에서 통과시킬 시나리오: ${scen.map((s) => `@${s.id}`).join(", ")}` : "이 작업에서 통과시킬 시나리오는 없습니다 (같은 요구사항의 뒤 작업에서 확인합니다).");
    }
    if (node.reads.includes("requirements")) {
      const reqs = trace.requirements.filter((r) => reqIds.includes(r.id)).map((r) => `- ${r.id} ${r.text}`);
      work.push(`### 요구사항 (${trace.dir}/spec.md)\n${reqs.join("\n")}`);
    }
    if (node.reads.includes("scenarios") && scen.length) {
      const files = [...new Set(scen.map((s) => s.file))];
      const blocks = files.map((f) => scenarioBlocks(readFileSync(join(root, f), "utf8"), scen.map((s) => s.id))).join("\n\n");
      work.push(`### 시나리오 (${files.join(", ")})\n\`\`\`gherkin\n${blocks}\n\`\`\``);
    }
    if (node.reads.includes("design")) {
      const design = join(root, trace.dir, "design.md");
      if (existsSync(design)) work.push(`### 설계 (${trace.dir}/design.md)\n${readFileSync(design, "utf8").trim()}`);
    }
    if (node.reads.includes("screens")) {
      const screens = screenWork(root, trace, task, node.id);
      if (screens) work.push(screens);
    }
  }

  const { events } = readEvents(root);
  if (node.reads.includes("diff")) {
    const ref = taskStartRef(events, task);
    // 화면 작업의 앱 코드(mobile/)도 함께. 잠금 파일은 길기만 하므로 뺀다 (조각 3)
    const diff = git(root, ["diff", `${ref}..HEAD`, "--", "src", "tests", "mobile", ":(exclude)mobile/package-lock.json"]).trim();
    work.push(`### 이 작업의 변경분 (git diff ${ref.slice(0, 7)}..HEAD -- src tests mobile)\n\`\`\`diff\n${diff || "(변경 없음)"}\n\`\`\``);
    // 이미 충족된 작업: 구현을 바꾸지 않고 넘어왔으므로, 인수 테스트가 시나리오를 제대로 확인하는지가 유일한 안전장치다.
    const met = events.some((e) => e.type === "node_end" && e.task === task && e.already_met);
    if (met && trace && t) {
      const scen = scenariosForTask(trace, task);
      const files = [...new Set(scen.map((s) => s.file))];
      const blocks = files.map((f) => scenarioBlocks(readFileSync(join(root, f), "utf8"), scen.map((s) => s.id))).join("\n\n");
      const tests = scen
        .map((s) => `tests/acceptance/${s.id}.test.ts`)
        .filter((f) => existsSync(join(root, f)))
        .map((f) => `#### ${f}\n\`\`\`ts\n${readFileSync(join(root, f), "utf8").trim()}\n\`\`\``)
        .join("\n\n");
      work.push(
        [
          "### 이미 충족된 작업",
          "이 작업의 시나리오는 앞 작업의 구현으로 이미 통과해서, 구현을 바꾸지 않고 N23~N25를 건너뛰었습니다.",
          "설계 대조와 함께, 아래 인수 테스트가 시나리오의 조건, 만일, 그러면을 실제로 확인하는지 봅니다. 확인하지 않는 테스트(항상 통과하는 테스트, 단계를 빼먹은 테스트)면 code_bug로 실패시키고 지적에 그 내용을 적습니다.",
          `\`\`\`gherkin\n${blocks}\n\`\`\``,
          tests || "(인수 테스트 파일을 찾지 못했습니다)",
        ].join("\n\n"),
      );
    }
  }
  if (node.reads.includes("last_gate")) {
    const lastEnd = lastFor(events, "node_end", (e) => e.task === task);
    // 마지막 노드가 실패했을 때만 붙인다 (이미 지나간 실패는 넣지 않는다). 관문 요약이나 리뷰 지적, 그리고 실패한 명령의 출력 끝부분.
    if (lastEnd && lastEnd.result === "fail") {
      const summary = join(root, GATE_DIR, `${lastEnd.id}.summary.md`);
      const failed = lastFor(events, "gate_run", (e) => e.run === lastEnd.id && e.result === "fail");
      const log = failed ? join(root, GATE_DIR, `${failed.id}.log`) : "";
      const tail = log && existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-60).join("\n").trim() : "";
      const body = [existsSync(summary) ? readFileSync(summary, "utf8").trim() : "", tail ? `출력 끝부분:\n\`\`\`\n${tail}\n\`\`\`` : ""].filter(Boolean).join("\n\n");
      if (body) work.push(`### 지난 관문 결과 (${lastEnd.node}${failed ? `, ${failed.id}` : ""})\n${body}`);
    }
  }
  if (node.reads.includes("hint")) {
    const hint = lastFor(events, "human", (e) => e.task === task && e.kind === "hint");
    const file = hint ? join(root, HUMAN_DIR, `${hint.id}.md`) : "";
    if (hint && existsSync(file)) work.push(`### 사람이 준 힌트 (${hint.id})\n${readFileSync(file, "utf8").trim()}`);
  }

  parts.push(work.join("\n\n"));
  return { prompt: parts.join("\n\n") + "\n", loaded };
}

// ---------------------------------------------------------------- Stage 2의 화면 작업 (조각 3)

/** states.md에서 그 시나리오들의 칸만 */
function stateBlocks(text: string, ids: string[]): string {
  return text
    .split(/^(?=##\s)/m)
    .filter((b) => ids.includes(/^##\s+(S\d+)\b/.exec(b)?.[1] ?? ""))
    .map((b) => b.trim())
    .join("\n\n");
}

/**
 * 화면 기능의 작업이면: 플랫폼, 시나리오마다 기준 화면과 플로우 파일, 화면 상태, 디자인 시스템 부품, 앱 ID.
 * 이미 쓴 플로우 파일은 내용까지 넣는다 (구현이 testID와 글자를 맞추게).
 */
function screenWork(root: string, trace: FeatureTrace, task: string, nodeId: string): string {
  let config;
  try {
    config = loadConfig(root);
  } catch {
    return "";
  }
  const platforms = taskPlatforms(root, config, task);
  if (!platforms.length) return "";
  const ids = scenariosForTask(trace, task).map((s) => s.id);
  const lines = [`### 화면 작업 (플랫폼: ${platforms.join(", ")})`];
  if (!ids.length) {
    lines.push("이 작업에서 통과시킬 화면 시나리오는 없습니다. 플로우 파일과 화면 비교는 같은 요구사항의 뒤 작업에서 합니다.");
  } else {
    lines.push(
      "이 작업의 시나리오는 앱 화면에서 확인합니다. 인수 테스트는 플랫폼마다 한 파일이고, 마지막에 찍은 화면을 N26F가 기준 화면과 비교합니다.",
      "",
      `| 시나리오 | 기준 화면 (N04 승인) | ${platforms.map((p) => (p === "android" ? "Android 플로우 (Maestro)" : "웹 테스트 (Playwright)")).join(" | ")} |`,
      `|---|---|${platforms.map(() => "---|").join("")}`,
      ...ids.map((id) => {
        const frame = existsSync(join(root, FRAMES_DIR, `${id}.png`)) ? `\`${FRAMES_DIR}/${id}.png\`` : "없음 (화면 없음)";
        return `| ${id} | ${frame} | ${platforms.map((p) => `\`${e2eFile(p, id)}\``).join(" | ")} |`;
      }),
      "",
      "- 기준 화면 이미지(1080×2400, 360×800 프레임의 3배)는 Read 도구로 열어 봅니다.",
      `- 찍은 화면: Android는 \`.4dd/shots/android/<S>.png\`(플로우의 \`- takeScreenshot: <S>\`를 하네스 스크립트가 모음), 웹은 \`.4dd/shots/web/<S>.png\`(\`page.screenshot\`의 path).`,
    );
  }
  const states = readText(root, `${trace.dir}/states.md`);
  const blocks = states && ids.length ? stateBlocks(states, ids) : "";
  if (blocks) lines.push("", `#### 화면 상태 (${trace.dir}/states.md, 이 작업의 시나리오)`, blocks);
  let parts: { component?: string; code?: string }[] = [];
  try {
    parts = JSON.parse(readText(root, CODE_CONNECT_FILE) ?? "[]") as typeof parts;
  } catch {
    parts = [];
  }
  lines.push(
    "",
    "#### 디자인 시스템 (고칠 수 없음, 이것만 씀)",
    `- 테마: \`${THEME_FILE}\` (값은 \`${TOKENS_FILE}\`에서 옴). 고정 색·간격·글자 크기를 쓰지 않습니다.`,
    ...(parts.length ? [`- 부품: ${parts.map((p) => `${p.component} \`${p.code}\``).join(", ")}`] : []),
  );
  try {
    const app = JSON.parse(readText(root, "mobile/app.json") ?? "{}") as { expo?: { android?: { package?: string } } };
    const id = app.expo?.android?.package;
    if (id && platforms.includes("android")) lines.push(`- Android 앱 ID(Maestro의 \`appId\`): \`${id}\``);
  } catch {
    /* app.json이 없거나 깨졌으면 넘어감 */
  }
  // 구현·정리·리뷰 노드에는 이미 쓴 플로우를 그대로 (testID와 글자를 맞추게)
  if (nodeId !== "N22") {
    const flows = platforms
      .flatMap((p) => ids.map((id) => e2eFile(p, id)))
      .filter((f) => existsSync(join(root, f)))
      .map((f) => `#### ${f}\n\`\`\`${f.endsWith(".yaml") ? "yaml" : "ts"}\n${cap(readText(root, f)?.trim() ?? "", 4000)}\n\`\`\``);
    if (flows.length) lines.push("", ...flows);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- Stage 0·1의 「이번 기능」 (조각 2)

const cap = (text: string, n = 8000) => (text.length > n ? `${text.slice(0, n)}\n… (${text.length - n}자 줄임)` : text);

/** 일감(기능 또는 Stage 2에서 돌아온 작업)의 마지막 노드가 실패했으면 그 관문 요약과 리뷰 지적 */
function lastFailure(root: string, events: LedgerEvent[], match: (e: Extract<LedgerEvent, { type: "node_end" }>) => boolean): string {
  const lastEnd = lastFor(events, "node_end", match);
  if (!lastEnd || lastEnd.result !== "fail") return "";
  const summary = join(root, GATE_DIR, `${lastEnd.id}.summary.md`);
  return existsSync(summary) ? `### 지난 관문 결과 (${lastEnd.node})\n${readFileSync(summary, "utf8").trim()}` : "";
}

/** 마지막 검토 승인 뒤에 남은 사람의 말 (PO의 되돌림 의견, 힌트, 원인을 승인하며 준 답) */
function humanWords(root: string, events: LedgerEvent[], match: (e: Extract<LedgerEvent, { type: "human" }>) => boolean): string[] {
  const mine = events.filter((e): e is Extract<LedgerEvent, { type: "human" }> => e.type === "human" && match(e));
  const after = mine.slice(mine.findLastIndex((e) => e.kind === "approve" && !!e.review) + 1);
  return after
    .filter((e) => ["reject", "hint", "approve"].includes(e.kind) && existsSync(join(root, HUMAN_DIR, `${e.id}.md`)))
    .map((e) => {
      const what = e.kind === "reject" ? `${e.node} 되돌림${e.cause ? ` · ${e.cause}` : ""}${e.to ? ` · ${e.to}부터` : ""}` : e.kind === "hint" ? "힌트" : `${e.node} 승인하며 준 답`;
      return `### PO의 말 (${e.id}, ${what})\n${readFileSync(join(root, HUMAN_DIR, `${e.id}.md`), "utf8").trim()}`;
    });
}

function planWork(root: string, node: NodeDef, feature: string, task: string | null): string[] {
  const { events } = readEvents(root);
  const reads = new Set(node.reads);
  const fp = (file: string) => featurePath(feature, file);
  const others = featureNames(root).filter((f) => f !== feature);
  const work: string[] = [`## 이번 기능 (${feature})`];

  if (task) {
    // Stage 2에서 돌아옴: 그 작업이 처음 실패한 판단 노드의 요약
    const fail = events.filter((e): e is Extract<LedgerEvent, { type: "node_end" }> => e.type === "node_end" && e.task === task && e.result === "fail" && (e.node === "N26" || e.node === "N27" || e.node === "N28")).at(-1);
    const summary = fail ? join(root, GATE_DIR, `${fail.id}.summary.md`) : "";
    work.push(
      [
        `### Stage 2에서 돌아옴 (작업 ${task}${fail ? `, ${fail.node}에서 ${fail.cause ?? ""}` : ""})`,
        node.id === "N02" ? "개발 중에 스펙의 빈틈이 드러나 PO 승인을 받고 돌아왔습니다. 요구사항을 더하거나 빼지 않고, 있는 요구사항의 문장과 규칙만 고칩니다. 새 요구는 새 스토리로 따로 받습니다." : "개발 중에 드러난 문제를 고치러 PO 승인을 받고 돌아왔습니다. 고친 뒤 다시 승인받으면 원래 작업으로 돌아갑니다.",
        summary && existsSync(summary) ? readFileSync(summary, "utf8").trim() : "",
      ].filter(Boolean).join("\n"),
    );
  }
  if (reads.has("story")) {
    const story = readText(root, fp("story.md"));
    if (story) work.push(`### 스토리 (PO의 말, ${fp("story.md")})\n${story.replace(/^#.*\n+/, "").trim()}`);
  }
  if (reads.has("spec")) {
    const spec = readText(root, fp("spec.md"));
    if (spec) work.push(`### 스펙 (${fp("spec.md")})\n${spec.trim()}`);
  }
  if (reads.has("ids")) {
    const own = featureIds(root, feature);
    const ownT = parseTasks(readText(root, fp("tasks.md")) ?? "", "tasks.md").tasks.map((t) => t.id);
    const n = nextIds(root);
    const has = [...own.R, ...own.S, ...ownT];
    work.push(
      [
        "### 이번 기능에서 쓸 ID",
        has.length ? `- 이 기능이 이미 쓰는 ID: ${has.join(", ")} (그대로 둡니다)` : "- 이 기능은 아직 ID가 없습니다.",
        `- 새로 쓰는 ID는 요구사항 R${n.R}, 시나리오 S${n.S}, 작업 T${n.T}부터 이어 씁니다. 다른 기능의 번호는 쓰지 않습니다.`,
      ].join("\n"),
    );
  }
  if (reads.has("other_specs") && others.length) {
    const lines = others.map((f) => {
      const reqs = parseSpec(readText(root, featurePath(f, "spec.md")) ?? "", "spec.md").requirements;
      return `- ${f}: ${reqs.map((r) => `${r.id} ${r.text}`).join(" / ")}`;
    });
    work.push(`### 다른 기능의 요구사항\n${lines.join("\n")}`);
  }
  if (reads.has("scenarios")) {
    const files = featureFiles(root, feature);
    if (files.length) work.push(`### 시나리오 (${files.join(", ")})\n\`\`\`gherkin\n${files.map((f) => readText(root, f) ?? "").join("\n").trim()}\n\`\`\``);
  }
  if (reads.has("design")) {
    const d = readText(root, fp("design.md"));
    if (d) work.push(`### 설계 (${fp("design.md")})\n${d.trim()}`);
  }
  if (reads.has("states")) {
    const s = readText(root, fp("states.md"));
    work.push(s ? `### 화면 상태 (${fp("states.md")})\n${s.trim()}` : `### 화면 상태\n${fp("states.md")}이 아직 없습니다.`);
  }
  if (reads.has("design_system")) {
    const tokens = readText(root, "design/tokens.json");
    const cc = readText(root, "design/code-connect.json");
    const fig = readText(root, "design/figma.json");
    if (fig) work.push(`### Figma 파일 (design/figma.json)\n\`\`\`json\n${fig.trim()}\n\`\`\``);
    work.push(
      tokens
        ? `### 디자인 시스템 (design/tokens.json, design/code-connect.json)\n\`\`\`json\n${tokens.trim()}\n\`\`\`\n\`\`\`json\n${(cc ?? "[]").trim()}\n\`\`\``
        : "### 디자인 시스템\n아직 없습니다 (N00F가 처음 화면 기능에서 만듭니다).",
    );
  }
  if (reads.has("other_designs")) {
    for (const f of others) {
      const d = readText(root, featurePath(f, "design.md"));
      if (d) work.push(`### 다른 기능의 설계 (${featurePath(f, "design.md")})\n${cap(d.trim(), 6000)}`);
    }
  }
  if (reads.has("src_map")) {
    // 화면 기능의 앱 코드(mobile/)와 디자인 시스템(design/)도 함께 (조각 3)
    const files = git(root, ["ls-files", "src", "tests", "mobile", "design"]).split("\n").filter((f) => f && !f.endsWith(".gitkeep") && !/^mobile\/assets\//.test(f) && !f.endsWith("package-lock.json"));
    const exportsOf = (f: string) =>
      (readText(root, f) ?? "")
        .split("\n")
        .filter((l) => /^export\s/.test(l))
        .map((l) => `    ${l.replace(/\s*\{\s*$/, "").slice(0, 140)}`)
        .slice(0, 12)
        .join("\n");
    const lines = files.map((f) => (f.startsWith("src/") || /^mobile\/.*\.tsx?$/.test(f) ? `- ${f}\n${exportsOf(f)}`.trimEnd() : `- ${f}`));
    work.push(`### 소스 파일 목록 (src/의 export 줄 포함)\n${lines.join("\n") || "(아직 없음)"}`);
  }
  if (reads.has("tasks")) {
    const t = readText(root, fp("tasks.md"));
    if (t) work.push(`### 작업 목록 (${fp("tasks.md")})\n${t.trim()}`);
  }
  if (reads.has("sprint")) {
    const s = readText(root, SPRINT_FILE);
    work.push(s ? `### 스프린트 (${SPRINT_FILE})\n${s.trim()}` : `### 스프린트\n${SPRINT_FILE}이 아직 없습니다.`);
    if (node.id === "N15") {
      const sprint = readSprint(root);
      for (const f of sprint?.features ?? [feature]) {
        const t = readText(root, featurePath(f, "tasks.md"));
        if (t && f !== feature) work.push(`### 작업 목록 (${featurePath(f, "tasks.md")})\n${t.trim()}`);
      }
    }
  }
  const inUnit = (e: { task: string | null; feature?: string }) => (task ? e.task === task : e.task === null && e.feature === feature);
  if (reads.has("last_gate")) {
    const f = lastFailure(root, events, (e) => inUnit(e));
    if (f) work.push(f);
  }
  if (reads.has("hint")) work.push(...humanWords(root, events, (e) => inUnit(e)));
  return work;
}
