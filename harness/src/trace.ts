// 추적 ID 검사 (하네스 설계 ③, 첫 구현 조각 명세 「시험 프로젝트와 추적 ID」)
//
// 기능 폴더(specs/<기능>/) 하나에서 요구사항(R), 시나리오(@S), 작업(T)의 ID를 읽고,
// 서로 빠짐없이 이어져 있는지 확인한다. 하네스는 이 결과로 작업마다 통과시킬 시나리오를 정한다.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type IssueLevel = "error" | "warning";

export interface TraceIssue {
  level: IssueLevel;
  file: string;
  line: number;
  message: string;
}

export interface Requirement {
  id: string;
  text: string;
  file: string;
  line: number;
}

export interface Scenario {
  id: string;
  reqs: string[];
  title: string;
  file: string;
  line: number;
}

export interface Task {
  id: string;
  reqs: string[];
  title: string;
  done: boolean;
  file: string;
  line: number;
}

export interface FeatureTrace {
  dir: string;
  requirements: Requirement[];
  scenarios: Scenario[];
  tasks: Task[];
  issues: TraceIssue[];
}

const REQ_LINE = /^\s*[-*]\s+(R\d+)\s+(.+?)\s*$/;
const TASK_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*$/;
const TASK_ID = /^(T\d+)\s+(.*)$/;
const TASK_REFS = /\((R\d+(?:\s*,\s*R\d+)*)\)\s*$/;
// 시나리오 개요를 시나리오보다 먼저 맞춰 본다. 한국어 "예:"는 Examples라서 시나리오가 아니다.
const SCENARIO_LINE = /^\s*(시나리오 개요|시나리오|Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$/;
const FEATURE_LINE = /^\s*(기능|Feature)\s*:/;

export function parseSpec(text: string, file: string): { requirements: Requirement[]; issues: TraceIssue[] } {
  const requirements: Requirement[] = [];
  const issues: TraceIssue[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = REQ_LINE.exec(raw);
    if (!m) return;
    const id = m[1];
    const line = i + 1;
    const first = seen.get(id);
    if (first !== undefined) {
      issues.push({ level: "error", file, line, message: `요구사항 ID ${id}가 겹칩니다 (처음은 ${first}번째 줄)` });
      return;
    }
    seen.set(id, line);
    requirements.push({ id, text: m[2], file, line });
  });
  if (requirements.length === 0) {
    issues.push({ level: "error", file, line: 1, message: "요구사항 ID(- R1 …)가 하나도 없습니다" });
  }
  return { requirements, issues };
}

export function parseFeature(text: string, file: string): { scenarios: Scenario[]; issues: TraceIssue[] } {
  const scenarios: Scenario[] = [];
  const issues: TraceIssue[] = [];
  let pending: string[] = [];
  let featureTags: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    if (trimmed.startsWith("@")) {
      pending.push(...trimmed.split(/\s+/).filter((t) => t.startsWith("@")).map((t) => t.slice(1)));
      return;
    }
    if (FEATURE_LINE.test(raw)) {
      featureTags = pending;
      pending = [];
      if (featureTags.some((t) => /^S\d+$/.test(t))) {
        issues.push({ level: "error", file, line, message: "시나리오 ID(@S)는 기능이 아니라 시나리오마다 붙입니다" });
      }
      return;
    }
    const m = SCENARIO_LINE.exec(raw);
    if (m) {
      const tags = [...featureTags.filter((t) => /^R\d+$/.test(t)), ...pending];
      pending = [];
      const sIds = tags.filter((t) => /^S\d+$/.test(t));
      const reqs = [...new Set(tags.filter((t) => /^R\d+$/.test(t)))];
      const title = m[2];
      if (sIds.length !== 1) {
        const why = sIds.length === 0 ? "시나리오 ID 태그(@S1 …)가 없습니다" : `시나리오 ID 태그가 여러 개입니다 (${sIds.map((s) => "@" + s).join(" ")})`;
        issues.push({ level: "error", file, line, message: `「${title}」: ${why}` });
      }
      if (reqs.length === 0) {
        issues.push({ level: "error", file, line, message: `「${title}」: 요구사항 태그(@R1 …)가 없습니다` });
      }
      if (sIds.length >= 1) scenarios.push({ id: sIds[0], reqs, title, file, line });
      return;
    }
    // 단계나 다른 키워드 줄이 나오면, 그 위의 태그는 시나리오에 붙은 것이 아니다.
    pending = [];
  });
  return { scenarios, issues };
}

export function parseTasks(text: string, file: string): { tasks: Task[]; issues: TraceIssue[] } {
  const tasks: Task[] = [];
  const issues: TraceIssue[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = TASK_LINE.exec(raw);
    if (!m) return;
    const line = i + 1;
    const done = m[1] !== " ";
    const body = m[2];
    const idm = TASK_ID.exec(body);
    if (!idm) {
      issues.push({ level: "error", file, line, message: `작업 ID(T1 …)가 없습니다: ${body}` });
      return;
    }
    const refm = TASK_REFS.exec(idm[2]);
    if (!refm) {
      issues.push({ level: "error", file, line, message: `${idm[1]}: 줄 끝에 요구사항 ID가 없습니다 (예: (R1))` });
    }
    const reqs = refm ? refm[1].split(/\s*,\s*/) : [];
    const title = refm ? idm[2].slice(0, refm.index).trim() : idm[2].trim();
    tasks.push({ id: idm[1], reqs, title, done, file, line });
  });
  if (tasks.length === 0 && issues.length === 0) {
    issues.push({ level: "error", file, line: 1, message: "작업(- [ ] T1 …)이 하나도 없습니다" });
  }
  return { tasks, issues };
}

/** 시나리오를 통과시켜야 하는 작업: 그 시나리오의 요구사항을 다루는 작업 가운데 tasks.md에서 가장 뒤에 있는 것. */
export function dueTask(trace: FeatureTrace, scenario: Scenario): Task | undefined {
  let due: Task | undefined;
  for (const t of trace.tasks) {
    if (t.reqs.some((r) => scenario.reqs.includes(r))) due = t;
  }
  return due;
}

/** 작업의 시나리오: 이 작업에서 인수 테스트를 쓰고 통과시켜야 하는 시나리오. */
export function scenariosForTask(trace: FeatureTrace, taskId: string): Scenario[] {
  return trace.scenarios.filter((s) => dueTask(trace, s)?.id === taskId);
}

/** 기능 폴더 하나(spec.md, *.feature, tasks.md)를 검사한다. 경로는 base 기준 상대 경로로 보고한다. */
export function checkFeatureDir(dir: string, base: string = dir): FeatureTrace {
  const rel = (p: string) => relative(base, p) || p;
  const issues: TraceIssue[] = [];
  const read = (name: string): string | undefined => {
    const p = join(dir, name);
    if (!existsSync(p)) {
      issues.push({ level: "error", file: rel(p), line: 1, message: `${name}이 없습니다` });
      return undefined;
    }
    return readFileSync(p, "utf8");
  };

  const specText = read("spec.md");
  const spec = specText === undefined ? { requirements: [], issues: [] } : parseSpec(specText, rel(join(dir, "spec.md")));
  const tasksText = read("tasks.md");
  const tasks = tasksText === undefined ? { tasks: [], issues: [] } : parseTasks(tasksText, rel(join(dir, "tasks.md")));
  const featureFiles = readdirSync(dir).filter((f) => f.endsWith(".feature")).sort();
  if (featureFiles.length === 0) {
    issues.push({ level: "error", file: rel(dir), line: 1, message: "시나리오 파일(.feature)이 없습니다" });
  }
  const scenarios: Scenario[] = [];
  for (const f of featureFiles) {
    const parsed = parseFeature(readFileSync(join(dir, f), "utf8"), rel(join(dir, f)));
    scenarios.push(...parsed.scenarios);
    issues.push(...parsed.issues);
  }
  issues.push(...spec.issues, ...tasks.issues);

  const trace: FeatureTrace = { dir: rel(dir), requirements: spec.requirements, scenarios, tasks: tasks.tasks, issues };
  const reqIds = new Set(spec.requirements.map((r) => r.id));

  const seenS = new Map<string, Scenario>();
  for (const s of scenarios) {
    const first = seenS.get(s.id);
    if (first) {
      issues.push({ level: "error", file: s.file, line: s.line, message: `시나리오 ID @${s.id}가 겹칩니다 (처음은 ${first.file}:${first.line})` });
    } else {
      seenS.set(s.id, s);
    }
    for (const r of s.reqs) {
      if (!reqIds.has(r)) issues.push({ level: "error", file: s.file, line: s.line, message: `@${s.id}: spec.md에 없는 요구사항 @${r}` });
    }
  }

  const seenT = new Map<string, Task>();
  for (const t of tasks.tasks) {
    const first = seenT.get(t.id);
    if (first) {
      issues.push({ level: "error", file: t.file, line: t.line, message: `작업 ID ${t.id}가 겹칩니다 (처음은 ${first.line}번째 줄)` });
    } else {
      seenT.set(t.id, t);
    }
    for (const r of t.reqs) {
      if (!reqIds.has(r)) issues.push({ level: "error", file: t.file, line: t.line, message: `${t.id}: spec.md에 없는 요구사항 ${r}` });
    }
  }

  for (const r of spec.requirements) {
    if (!scenarios.some((s) => s.reqs.includes(r.id))) {
      issues.push({ level: "error", file: r.file, line: r.line, message: `${r.id}: 이 요구사항을 검증하는 시나리오가 없습니다` });
    }
    if (!tasks.tasks.some((t) => t.reqs.includes(r.id))) {
      issues.push({ level: "error", file: r.file, line: r.line, message: `${r.id}: 이 요구사항을 구현하는 작업이 없습니다` });
    }
  }

  for (const t of tasks.tasks) {
    if (scenariosForTask(trace, t.id).length === 0) {
      issues.push({ level: "warning", file: t.file, line: t.line, message: `${t.id}: 이 작업에서 통과시킬 시나리오가 없습니다 (같은 요구사항의 뒤 작업에서 확인합니다)` });
    }
  }
  return trace;
}

/** 프로젝트의 specs/ 아래 기능 폴더를 모두 검사한다. */
export function checkProject(root: string): FeatureTrace[] {
  const specs = join(root, "specs");
  if (!existsSync(specs)) {
    return [{ dir: "specs", requirements: [], scenarios: [], tasks: [], issues: [{ level: "error", file: "specs", line: 1, message: "specs 폴더가 없습니다" }] }];
  }
  return readdirSync(specs)
    .filter((d) => statSync(join(specs, d)).isDirectory() && existsSync(join(specs, d, "spec.md")))
    .sort()
    .map((d) => checkFeatureDir(join(specs, d), root));
}

export function formatIssues(traces: FeatureTrace[]): string {
  const lines: string[] = [];
  for (const t of traces) {
    for (const i of t.issues) {
      lines.push(`${i.level === "error" ? "오류" : "주의"} ${i.file}:${i.line} ${i.message}`);
    }
  }
  return lines.join("\n");
}
