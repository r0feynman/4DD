// 검토 페이지 (조각 2 명세 「검토 페이지」)
//
// PO가 휴대폰에서 읽고 채팅으로 승인할 한 장짜리 HTML을 파일에서 바로 만든다(토큰이 들지 않음).
// 아티팩트 규칙: 두세 단어 제목, 밝은·어두운 화면의 색, 휴대폰 폭에서 가로로 넘치지 않음, 바깥 스크립트 없음.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { GATE_DIR } from "./gate.ts";
import type { LedgerEvent } from "./ledger.ts";
import type { NodeDef } from "./nodes.ts";
import { DESIGN_SECTIONS, featureFiles, featurePath, listItems, openQuestions, readSprint, readText, sections, type FileHash } from "./plan.ts";
import { checkFeatureDir, parseSpec, parseTasks, scenariosForTask } from "./trace.ts";

export interface ReviewPageInput {
  root: string;
  node: NodeDef;
  feature: string;
  id: string;
  hash: string;
  files: FileHash[];
  events: LedgerEvent[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const md = (s: string) => marked.parse(s, { async: false }) as string;
/** 문장 안의 R4, S5, T6을 칩으로 */
const chips = (s: string) => esc(s).replace(/\b([RST])(\d+)\b/g, '<span class="id id-$1">$1$2</span>');
const idChip = (id: string) => `<span class="id id-${id[0]}">${esc(id)}</span>`;

/** 기능의 이름: 스펙 제목(「# 요구사항 스펙: 비밀번호 재설정 (N02)」)에서, 없으면 폴더 이름 */
export function featureTitle(root: string, feature: string): string {
  const spec = readText(root, featurePath(feature, "spec.md")) ?? "";
  const m = /^#\s+[^:\n]*:\s*(.+?)\s*(\(N\d+\))?\s*$/m.exec(spec);
  return m ? m[1] : feature;
}

interface ScenarioView {
  id: string;
  reqs: string[];
  title: string;
  steps: { kw: string; text: string }[];
  table: string[][];
}

const STEP = /^\s*(조건|만일|그러면|그리고|하지만|Given|When|Then|And|But)\s+(.*)$/;
const SCEN = /^\s*(시나리오 개요|시나리오|Scenario Outline|Scenario|Example)\s*:\s*(.*)$/;

/** .feature를 화면용으로 읽는다 (배경은 첫 시나리오 앞에 따로) */
function readScenarios(text: string): { background: { kw: string; text: string }[]; scenarios: ScenarioView[] } {
  const background: { kw: string; text: string }[] = [];
  const scenarios: ScenarioView[] = [];
  let tags: string[] = [];
  let featureTags: string[] = [];
  let cur: ScenarioView | null = null;
  let inBackground = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("@")) {
      tags.push(...line.split(/\s+/).filter((t) => t.startsWith("@")).map((t) => t.slice(1)));
      continue;
    }
    if (/^(기능|Feature)\s*:/.test(line)) {
      featureTags = tags;
      tags = [];
      continue;
    }
    if (/^(배경|Background)\s*:/.test(line)) {
      inBackground = true;
      continue;
    }
    const s = SCEN.exec(line);
    if (s) {
      inBackground = false;
      const all = [...featureTags.filter((t) => /^R\d+$/.test(t)), ...tags];
      cur = { id: all.find((t) => /^S\d+$/.test(t)) ?? "?", reqs: [...new Set(all.filter((t) => /^R\d+$/.test(t)))], title: s[2], steps: [], table: [] };
      scenarios.push(cur);
      tags = [];
      continue;
    }
    const st = STEP.exec(line);
    if (st) {
      (inBackground ? background : (cur?.steps ?? background)).push({ kw: st[1], text: st[2] });
      continue;
    }
    if (line.startsWith("|") && cur) cur.table.push(line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  return { background, scenarios };
}

const KW_CLASS: Record<string, string> = { 조건: "given", Given: "given", 만일: "when", When: "when", 그러면: "then", Then: "then" };

function scenarioCard(s: ScenarioView): string {
  const steps = s.steps.map((x) => `<li><b class="kw ${KW_CLASS[x.kw] ?? "and"}">${esc(x.kw)}</b> ${esc(x.text)}</li>`).join("");
  const table = s.table.length
    ? `<div class="tbl"><table>${s.table.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</table></div>`
    : "";
  return `<article class="card scen"><header>${idChip(s.id)}${s.reqs.map(idChip).join("")}<b>${esc(s.title)}</b></header><ol class="steps">${steps}</ol>${table}</article>`;
}

function n04Body(root: string, feature: string): string {
  const story = (readText(root, featurePath(feature, "story.md")) ?? "").replace(/^#.*\n+/, "").trim();
  const specText = readText(root, featurePath(feature, "spec.md")) ?? "";
  const sec = sections(specText);
  const reqs = parseSpec(specText, "spec.md").requirements;
  const questions = openQuestions(specText);
  const scen = featureFiles(root, feature).map((f) => readScenarios(readText(root, f) ?? ""));
  const all = scen.flatMap((x) => x.scenarios);
  const background = scen.flatMap((x) => x.background);
  const reqCards = reqs
    .map((r) => {
      const ss = all.filter((s) => s.reqs.includes(r.id));
      return `<article class="card req"><header>${idChip(r.id)}</header><p>${chips(r.text)}</p><footer>${ss.length ? `시나리오 ${ss.map((s) => idChip(s.id)).join("")}` : '<span class="warn">이 요구사항을 확인하는 시나리오가 없습니다</span>'}</footer></article>`;
    })
    .join("");
  return `
<section class="story"><span class="k">PO의 스토리</span><p>${esc(story)}</p></section>
${questions.length ? `<section class="ask"><h2>답이 필요한 것 ${questions.length}개</h2><p>이 질문에 답해 주셔야 승인할 수 있습니다. 답을 받으면 스펙을 고쳐 다시 보여 드립니다.</p><ol>${questions.map((q) => `<li>${chips(q)}</li>`).join("")}</ol></section>` : ""}
<section><h2>목적</h2><p class="lead">${esc(sec.get("목적") ?? "")}</p></section>
<section><h2>요구사항 ${reqs.length}개</h2><div class="grid">${reqCards}</div></section>
<section><h2>시나리오 ${all.length}개</h2>
${background.length ? `<div class="bg"><span class="k">모든 시나리오의 시작</span><ol class="steps">${background.map((x) => `<li><b class="kw ${KW_CLASS[x.kw] ?? "and"}">${esc(x.kw)}</b> ${esc(x.text)}</li>`).join("")}</ol></div>` : ""}
<div class="grid">${all.map(scenarioCard).join("")}</div></section>
<section class="two"><div><h2>하지 않는 것</h2><ul>${listItems(sec.get("범위 밖")).map((x) => `<li>${chips(x)}</li>`).join("") || "<li>없음</li>"}</ul></div>
<div><h2>지켜야 할 것</h2><ul>${listItems(sec.get("제약")).map((x) => `<li>${chips(x)}</li>`).join("") || "<li>없음</li>"}</ul></div></section>
<section class="how"><h2>답하는 법</h2><p>채팅에 <b>「승인」</b>이라고 적어 주세요. 고칠 점이나 물을 것의 답이 있으면 그대로 적어 주세요. 에이전트가 스펙과 시나리오를 고쳐 새 검토 페이지를 보여 드립니다.</p></section>`;
}

function reviewResults(root: string, feature: string, events: LedgerEvent[]): string {
  const rows: string[] = [];
  for (const node of ["N13", "N14"]) {
    const ends = events.filter((e) => e.type === "node_end" && e.node === node && e.feature === feature);
    const fails = ends.filter((e) => e.type === "node_end" && e.result === "fail");
    const lastPass = ends.filter((e) => e.type === "node_end" && e.result === "pass").at(-1);
    const lastFail = fails.at(-1);
    const finding = lastFail?.type === "node_end" && existsSync(join(root, GATE_DIR, `${lastFail.id}.summary.md`)) ? readFileSync(join(root, GATE_DIR, `${lastFail.id}.summary.md`), "utf8").trim() : "";
    const label = node === "N13" ? "설계 리뷰" : "작업 나누기 리뷰";
    rows.push(
      `<article class="card rv ${lastPass ? "ok" : "no"}"><header><b>${node} ${label}</b><span class="badge">${lastPass ? "통과" : "아직 통과 못 함"}</span></header>` +
        `<p>${fails.length ? `리뷰가 ${fails.length}번 고치게 한 뒤 통과했습니다.` : "첫 차례에 통과했습니다."}</p>` +
        (finding ? `<details><summary>마지막으로 고치게 한 지적</summary><pre>${esc(finding.slice(0, 1500))}</pre></details>` : "") +
        "</article>",
    );
  }
  return rows.join("");
}

function n15Body(root: string, feature: string, events: LedgerEvent[]): string {
  const sprint = readSprint(root) ?? { goal: "", features: [], backlog: [] };
  const trace = checkFeatureDir(join(root, "specs", feature), root, "full");
  const tasksText = readText(root, featurePath(feature, "tasks.md")) ?? "";
  const tasks = parseTasks(tasksText, "tasks.md").tasks;
  const lane = sprint.backlog
    .map((id, i) => {
      const t = tasks.find((x) => x.id === id);
      const ss = t ? scenariosForTask(trace, t.id).map((s) => s.id) : [];
      return `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ""}<article class="card task"><header>${idChip(id)}${t ? t.reqs.map(idChip).join("") : ""}</header><p>${esc(t?.title ?? "(작업 목록에 없음)")}</p><footer>${ss.length ? `통과시킬 시나리오 ${ss.map(idChip).join("")}` : '<span class="muted">시나리오는 같은 요구사항의 뒤 작업이 확인</span>'}</footer></article>`;
    })
    .join("");
  const design = readText(root, featurePath(feature, "design.md")) ?? "";
  const dsec = sections(design);
  const designHtml = DESIGN_SECTIONS.map((name) => `<article class="card dsec${name === "기존 기능에 주는 영향" ? " impact" : ""}"><h3>${esc(name)}</h3><div class="md">${md(dsec.get(name) ?? "(비어 있음)")}</div></article>`).join("");
  return `
<section class="goal"><span class="k">이번 스프린트의 목표</span><p>${esc(sprint.goal)}</p><div>${sprint.features.map((f) => `<span class="feat">${esc(f)}</span>`).join("")}</div></section>
<section><h2>할 순서 (백로그 ${sprint.backlog.length}개)</h2><div class="lane">${lane}</div></section>
<section><h2>설계 요약</h2><p class="muted">개발자가 아니어도 「기존 기능에 주는 영향」만은 확인해 주세요. 이미 쓰는 기능이 어떻게 바뀌는지 적혀 있습니다.</p><div class="grid">${designHtml}</div></section>
<section><h2>리뷰 세션의 확인</h2><div class="grid">${reviewResults(root, feature, events)}</div></section>
<section class="how"><h2>답하는 법</h2><p>채팅에 <b>「승인」</b>이라고 적어 주세요. 고칠 곳이 있으면 목표·백로그, 설계, 작업 나누기 가운데 어디인지와 무엇을 바꿀지 적어 주세요. 승인하면 개발(Stage 2)이 시작됩니다.</p></section>`;
}

const CSS = `
:root { --bg:#f6f7f9; --surface:#fff; --fg:#17202b; --muted:#5b6675; --line:#dde2e8; --accent:#2f5fb3; --human:#9a5b00; --human-bg:#fbefdc; --ok:#1f7a4d; --warn:#b3261e; --R:#2f5fb3; --S:#1f7a4d; --T:#b35c00; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#11161d; --surface:#19212b; --fg:#e7edf4; --muted:#9aa7b6; --line:#2c3846; --accent:#7ea6f0; --human:#f2b55c; --human-bg:#3a2a12; --ok:#5fc795; --warn:#ff8a80; --R:#7ea6f0; --S:#5fc795; --T:#f0a35c; } }
:root[data-theme="dark"] { --bg:#11161d; --surface:#19212b; --fg:#e7edf4; --muted:#9aa7b6; --line:#2c3846; --accent:#7ea6f0; --human:#f2b55c; --human-bg:#3a2a12; --ok:#5fc795; --warn:#ff8a80; --R:#7ea6f0; --S:#5fc795; --T:#f0a35c; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.6 system-ui, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; word-break: keep-all; overflow-wrap: anywhere; }
.wrap { max-width: 980px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 24px; margin: 6px 0 4px; } h2 { font-size: 18px; margin: 28px 0 10px; } h3 { font-size: 15px; margin: 0 0 6px; }
.meta { display:flex; flex-wrap:wrap; gap:6px; color:var(--muted); font-size:13px; }
.meta span { border:1px solid var(--line); border-radius:999px; padding:1px 10px; background:var(--surface); }
.k { display:block; font-size:12px; font-weight:700; color:var(--muted); }
.story, .goal { background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:10px; padding:14px 16px; margin-top:16px; }
.story p, .goal p { margin:6px 0 0; font-size:16px; }
.ask { background:var(--human-bg); border:1.5px solid var(--human); border-radius:12px; padding:14px 16px; margin-top:16px; }
.ask h2 { margin:0 0 4px; color:var(--human); } .ask p { margin:0 0 8px; }
.lead { font-size:16px; margin:0; }
.grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap:10px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:12px 14px; min-width:0; display:flex; flex-direction:column; gap:6px; }
.card header { display:flex; flex-wrap:wrap; gap:6px; align-items:center; } .card p { margin:0; } .card footer { font-size:13px; color:var(--muted); display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.id { font: 700 12px/1 ui-monospace, Menlo, monospace; border-radius:5px; padding:3px 6px; border:1px solid currentColor; }
.id-R { color:var(--R); } .id-S { color:var(--S); } .id-T { color:var(--T); }
.steps { margin:0; padding-left:18px; } .steps li { margin:2px 0; }
.kw { font-weight:700; } .kw.given { color:var(--muted); } .kw.when { color:var(--accent); } .kw.then { color:var(--S); }
.bg { background:var(--surface); border:1px dashed var(--line); border-radius:10px; padding:10px 14px; margin-bottom:10px; }
.tbl { overflow-x:auto; } table { border-collapse:collapse; font-size:13px; margin-top:4px; } th, td { border:1px solid var(--line); padding:3px 8px; text-align:left; }
.two { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap:12px; }
.two ul { margin:0; padding-left:18px; }
.lane { display:flex; flex-wrap:wrap; gap:8px; align-items:stretch; } .lane .card { flex: 1 1 200px; } .arrow { align-self:center; color:var(--muted); font-size:18px; }
.feat { display:inline-block; margin-top:8px; font:600 12px/1 ui-monospace, Menlo, monospace; border:1px solid var(--line); border-radius:5px; padding:4px 7px; }
.dsec.impact { border:1.5px solid var(--human); }
.md :is(p, ul, ol, pre) { margin: 4px 0; } .md pre, pre { white-space: pre-wrap; font-size:12.5px; background:var(--bg); border-radius:6px; padding:8px; }
.rv header { justify-content:space-between; } .badge { font-size:12px; font-weight:700; border-radius:999px; padding:1px 9px; }
.rv.ok .badge { color:var(--ok); border:1px solid var(--ok); } .rv.no .badge { color:var(--warn); border:1px solid var(--warn); }
.how { background:var(--surface); border:1.5px solid var(--fg); border-radius:12px; padding:14px 16px; margin-top:28px; } .how h2 { margin-top:0; }
.warn { color:var(--warn); } .muted { color:var(--muted); font-size:13px; }
details.src { margin-top:28px; } details.src pre { max-height: 420px; overflow:auto; }
footer.stamp { margin-top:28px; color:var(--muted); font-size:12px; }
`;

export function renderReviewPage(input: ReviewPageInput): string {
  const { root, node, feature, id, hash, files, events } = input;
  const name = featureTitle(root, feature);
  const title = `${name} 검토`;
  const isPlan = node.approve?.packet === "1-2";
  const body = isPlan ? n15Body(root, feature, events) : n04Body(root, feature);
  const sources = files
    .map((f) => `<details class="src"><summary>원문 · <code>${esc(f.path)}</code></summary><pre>${esc(readText(root, f.path) ?? "(없음)")}</pre></details>`)
    .join("");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<div class="meta"><span>${isPlan ? "Stage 1 · N15 목표와 백로그 승인" : "Stage 0 · N04 스펙과 시나리오 승인"}</span><span>검토 ${esc(id)}</span><span>해시 ${esc(hash.slice(0, 8))}</span></div>
<h1>${esc(name)}</h1>
${body}
${sources}
<footer class="stamp">이 페이지는 하네스가 파일에서 바로 만들었습니다 (${esc(node.id)} · ${esc(id)} · ${esc(hash.slice(0, 12))}). 승인은 이 해시의 파일에만 적용됩니다.</footer>
</div>
</body>
</html>
`;
}
