// 관문: 노드가 끝났는지 기계가 판정한다 (하네스 설계 ⑤ 「관문 계약」, 첫 구현 조각 명세 「노드마다 누가 무엇을」).
//
// 관문은 지휘 프로그램이 직접 돌린다. 에이전트는 판정하지 않는다.
// 명령마다 관문 실행 기록(gate_run)을 원장에 남기고, 출력은 .4dd/gates/<ID>.log에 둔다(원장에는 ID만).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { appendEvent, DIR, nextId, readEvents, type LedgerEvent } from "./ledger.ts";
import { checkCodeConnect, checkFrames, checkStates, checkTokens, FRAMES_DIR } from "./design.ts";
import { compareShot, describe as describeVisual, visualSettings } from "./visual.ts";
import { changedFiles } from "./git.ts";
import { baselineDiff } from "./lock.ts";
import { getNode, GATE_CHECKS, type Cause, type NodeSet } from "./nodes.ts";
import { DESIGN_SECTIONS, E2E_DIR, E2E_EXT, e2eFile, featureIds, featureOfTask, featurePath, featurePlatforms, featureWorkType, lastPacket, openQuestions, packetDrift, readSprint, readText, sections, SPEC_SECTIONS, SPRINT_FILE, type Platform } from "./plan.ts";
import { countAtRef, countSource, countWorktree } from "./testscan.ts";
import { checkProject, parseSpec, scenariosForTask, type TraceMode } from "./trace.ts";

export const GATE_DIR = `${DIR}/gates`;
/** 통과한 리뷰 세션이 남긴 참고 지적의 머리말 (검토 페이지가 찾음) */
export const REVIEW_NOTE_HEAD = "리뷰 세션의 참고 (통과):";
/** 리뷰 세션이 승인된 스펙·시나리오끼리의 모순을 찾았을 때 지적 앞에 붙이는 말 (N13.review.md) */
export const SPEC_CONFLICT = "스펙·시나리오 모순";
export const GATE_TIMEOUT_MS = 10 * 60_000;
/** 플로우 파일 하나에 더 주는 시간 (조각 3, 2026-11-27 실제 실행: 잠금 시나리오 7개가 Android에서 10분을 넘음) */
export const FLOW_SECONDS: Record<Platform, number> = { android: 180, web: 60 };
export const ACCEPTANCE_DIR = "tests/acceptance";
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export type GateCheck = (typeof GATE_CHECKS)[number];

export interface GateContext {
  root: string;
  config: Config;
  nodes: NodeSet;
  nodeId: string;
  task: string | null;
  /** 지금 기능 폴더 이름. Stage 0·1의 검사(스펙 칸, 추적, 설계 칸, 패킷)가 이 기능을 본다 (조각 2) */
  feature?: string | null;
  /** 이 관문을 부른 노드 실행 ID (NR…) */
  runId: string;
  timeoutMs?: number;
}

export interface GateRunResult {
  id: string;
  command: string;
  exit: number;
  /** 관문 조건을 채웠나 (expect: fail이면 명령이 실패해야 pass) */
  result: "pass" | "fail";
  flakyRerun: boolean;
  log: string;
  /** 앱 빌드 명령 ({e2e.build}) */
  build?: boolean;
  /** 시간 제한을 넘어 끊음 (그 제한, 초) */
  timedOutSec?: number;
}

export interface GateCheckResult {
  name: GateCheck;
  ok: boolean;
  detail: string;
}

export interface GateOutcome {
  node: string;
  passed: boolean;
  /** 기계가 정할 수 있는 실패 원인 (test_flaky, env). 없으면 분류 차례에서 정한다 */
  cause?: Cause;
  runs: GateRunResult[];
  checks: GateCheckResult[];
  /** 다음 차례의 맥락에 붙일 한국어 요약 */
  summary: string;
  /** 실패해야 하는 관문이 앞 작업의 구현으로 이미 통과함 (already_met로 감) */
  alreadyMet?: boolean;
}

/** 작업의 시나리오와 인수 테스트 파일. 파일이 아직 없으면 정해진 이름(tests/acceptance/S1.test.ts)을 준다. */
/** 플랫폼의 모든 플로우 파일 (N28이 전체를 돌릴 때) */
export function allE2eFiles(root: string, platform: Platform): string[] {
  const dir = join(root, E2E_DIR[platform]);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(E2E_EXT[platform])).sort().map((f) => `${E2E_DIR[platform]}/${f}`) : [];
}

/** 화면 기능의 작업이면 플랫폼 목록, 아니면 빈 목록 (조각 3) */
export function taskPlatforms(root: string, config: Config, task: string | null): Platform[] {
  if (!task) return [];
  return featurePlatforms(featureWorkType(root, featureOfTask(root, task), config.work_type), config.platforms);
}

/** 작업의 시나리오가 그 플랫폼에서 쓰는 플로우 파일 */
export function platformScenarios(root: string, task: string, platform: Platform): { ids: string[]; files: string[] } {
  const { ids } = taskScenarios(root, task);
  return { ids, files: ids.map((id) => e2eFile(platform, id)) };
}

export function taskScenarios(root: string, task: string): { ids: string[]; files: string[] } {
  const trace = checkProject(root).find((t) => t.tasks.some((x) => x.id === task));
  if (!trace) return { ids: [], files: [] };
  const ids = scenariosForTask(trace, task).map((s) => s.id);
  const dir = join(root, ACCEPTANCE_DIR);
  const existing = existsSync(dir) ? readdirSync(dir).filter((f) => TEST_FILE.test(f)) : [];
  const files = ids.map((id) => {
    const hit = existing.find((f) => f.startsWith(`${id}.`));
    return `${ACCEPTANCE_DIR}/${hit ?? `${id}.test.ts`}`;
  });
  return { ids, files };
}

/** 작업을 시작한 커밋: 원장에서 그 작업의 N21 커밋. 없으면 HEAD. */
export function taskStartRef(events: LedgerEvent[], task: string | null): string {
  const hit = events.filter((e) => e.type === "commit" && e.node === "N21" && e.task === task).at(-1);
  return hit && hit.type === "commit" ? hit.sha : "HEAD";
}

function expand(template: string, config: Config, scenarioFiles: string[], platform?: Platform, root?: string): string {
  return template
    .replace(/\{e2e\.(build|run_files)\}/g, (_, k: "build" | "run_files") => {
      const v = platform ? config.commands.e2e?.[platform]?.[k] : undefined;
      if (!v) throw new Error(`4dd.config.yaml에 commands.e2e.${platform ?? "<플랫폼>"}.${k}가 없습니다`);
      return v;
    })
    .replace(/\{platform\.all_files\}/g, () => (platform && root ? allE2eFiles(root, platform).join(" ") : ""))
    .replace(/\{commands\.(\w+)\}/g, (_, k: string) => {
      const cmds = config.commands as unknown as Record<string, string | undefined>;
      // run_files가 없으면 acceptance로 대신한다 (그러면 인수 테스트 전체가 돌 수 있다)
      const v = cmds[k] ?? (k === "run_files" ? cmds.acceptance : undefined);
      if (!v) throw new Error(`4dd.config.yaml에 commands.${k}가 없습니다`);
      return v;
    })
    .replace(/\{task\.scenario_files\}/g, scenarioFiles.join(" "));
}

function parseVitestTests(output: string): { total: number; failed: number; skipped?: number } | undefined {
  const line = output.split("\n").find((l) => /^\s*Tests\s+/.test(l) && /\(\d+\)/.test(l));
  if (!line) return undefined;
  const num = (re: RegExp) => Number(re.exec(line)?.[1] ?? 0);
  const total = num(/\((\d+)\)/);
  const skipped = num(/(\d+) skipped/);
  return { total, failed: num(/(\d+) failed/), ...(skipped ? { skipped } : {}) };
}

function runCommand(root: string, command: string, timeoutMs: number): { exit: number; output: string; timedOut: boolean; seconds: number } {
  const started = Date.now();
  const r = spawnSync("sh", ["-c", command], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    // 하네스를 테스트 실행기 안에서 돌릴 때 그 환경 변수가 프로젝트의 테스트 실행기에 새지 않게 뺀다.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))), CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const exit = r.status ?? (timedOut ? 124 : 1);
  return { exit, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

/** gate_run에 더 남길 것 (조각 3) */
interface RunExtra {
  seconds?: number;
  /** 시간 제한을 넘어 끊었으면 그 제한(초). 원장에는 남기지 않고 요약에만 씀 */
  timedOutSec?: number;
  build?: boolean;
  scenario?: string;
  diff_percent?: number;
  tolerance?: number;
}

function record(ctx: GateContext, command: string, exit: number, result: "pass" | "fail", flakyRerun: boolean, output: string, platform?: Platform, extra: RunExtra = {}): GateRunResult {
  const { events } = readEvents(ctx.root);
  const id = nextId(events, "GR");
  mkdirSync(join(ctx.root, GATE_DIR), { recursive: true });
  const log = `${GATE_DIR}/${id}.log`;
  const tail = output.split("\n").slice(-300).join("\n");
  writeFileSync(join(ctx.root, log), `$ ${command}\n(종료 코드 ${exit})\n\n${tail}\n`, "utf8");
  const tests = parseVitestTests(output);
  appendEvent(ctx.root, ctx.nodes.version, {
    type: "gate_run",
    id,
    node: ctx.nodeId,
    task: ctx.task,
    run: ctx.runId,
    exit,
    result,
    ...(flakyRerun ? { flaky_rerun: true } : {}),
    ...(platform ? { platform } : {}),
    ...(tests ? { tests } : {}),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "timedOutSec")),
  });
  return { id, command, exit, result, flakyRerun, log, ...(extra.build ? { build: true } : {}), ...(extra.timedOutSec ? { timedOutSec: extra.timedOutSec } : {}) };
}

/**
 * 리뷰(N27)가 「동작은 맞는데 단위 테스트가 없음」으로 이 노드에 보냈고, 그 뒤로 이 노드가 아직 통과하지 않았는가.
 * 그때 새 테스트는 처음부터 통과하므로 「처음엔 실패」를 요구하지 않는다 (새 테스트가 늘었는지는 그대로 봄).
 */
export function reviewAskedTests(events: LedgerEvent[], task: string, nodeId: string): boolean {
  const at = events.findLastIndex((e) => e.type === "node_end" && e.task === task && e.node === "N27");
  const r = events[at];
  if (!r || r.type !== "node_end" || r.result !== "fail" || r.next !== nodeId || r.then !== "N27") return false;
  return !events.slice(at + 1).some((e) => e.type === "node_end" && e.task === task && e.node === nodeId && e.result === "pass");
}

/**
 * 이 작업이 스펙을 고치러 갔다가 N04에서 다시 승인받았고, 그 뒤로 이 노드가 아직 통과하지 않았는가.
 * 스펙이 바뀌면 앞 작업이 쓴 단위 테스트가 옛 예시를 쓰고 있을 수 있다 (예: 아이디 lee → lee01).
 */
export function specReapproved(events: LedgerEvent[], task: string, nodeId: string): boolean {
  const at = events.findLastIndex((e) => e.type === "human" && e.kind === "approve" && !!e.review && e.task === task && e.node === "N04");
  if (at < 0) return false;
  return !events.slice(at + 1).some((e) => e.type === "node_end" && e.task === task && e.node === nodeId && e.result === "pass");
}

function runCheck(name: GateCheck, ctx: GateContext, scenarios: { ids: string[]; files: string[] }, events: LedgerEvent[], specChanged = false): GateCheckResult {
  const { root } = ctx;
  const startRef = taskStartRef(events, ctx.task);
  switch (name) {
    case "scenario_files_exist": {
      // Maestro 플로우(.yaml)는 단계(- …)가 하나라도 있으면, 나머지(vitest·Playwright)는 테스트가 하나라도 있으면 있다고 본다
      const empty = (file: string, text: string) => (file.endsWith(".yaml") ? !/^\s*-\s+\S/m.test(text) : countSource(text).tests === 0);
      const missing = scenarios.files
        .map((file, i) => ({ file, id: scenarios.ids[i] }))
        .filter(({ file }) => {
          const f = join(root, file);
          return !existsSync(f) || empty(file, readFileSync(f, "utf8"));
        });
      return missing.length
        ? { name, ok: false, detail: `시나리오마다 인수 테스트가 있어야 합니다. 없거나 테스트가 비어 있는 시나리오: ${missing.map((m) => `@${m.id} (${m.file})`).join(", ")}` }
        : { name, ok: true, detail: `시나리오 ${new Set(scenarios.ids).size}개의 인수 테스트 ${scenarios.files.length}개가 있습니다` };
    }
    case "new_tests": {
      const before = countAtRef(root, "HEAD", "tests/unit").tests;
      const now = countWorktree(root, "tests/unit").tests;
      if (specChanged && now >= before && changedFiles(root).some((f) => f.startsWith("tests/unit/"))) {
        return { name, ok: true, detail: `스펙이 바뀌어 돌아온 작업이라, 기존 단위 테스트를 새 스펙에 맞게 고친 것을 받았습니다 (${before}개 → ${now}개)` };
      }
      return now > before
        ? { name, ok: true, detail: `단위 테스트가 ${before}개에서 ${now}개로 늘었습니다` }
        : { name, ok: false, detail: `새 단위 테스트가 없습니다 (노드 시작 때 ${before}개, 지금 ${now}개)` };
    }
    case "test_count_kept": {
      // 작업 시작 때와 노드 시작 때(마지막 커밋) 가운데 많은 쪽보다 줄면 안 된다. 작업 중에 쓴 테스트를 지우는 것도 잡기 위해서다.
      const atStart = countAtRef(root, startRef).tests;
      const atNode = countAtRef(root, "HEAD").tests;
      const before = Math.max(atStart, atNode);
      const now = countWorktree(root).tests;
      return now >= before
        ? { name, ok: true, detail: `테스트 수 ${now}개 (작업 시작 때 ${atStart}개, 노드 시작 때 ${atNode}개)` }
        : { name, ok: false, detail: `테스트가 줄었습니다: 작업 시작 때 ${atStart}개, 노드 시작 때 ${atNode}개, 지금 ${now}개` };
    }
    case "visual_match": {
      // 화면 비교 (N26F, 조각 3): 작업의 화면 시나리오(프레임 이미지가 있는 것) × 플랫폼
      const platforms = taskPlatforms(root, ctx.config, ctx.task);
      const ids = scenarios.ids.filter((id, i) => scenarios.ids.indexOf(id) === i).filter((id) => existsSync(join(root, FRAMES_DIR, `${id}.png`)));
      if (!platforms.length || !ids.length) return { name, ok: true, detail: "비교할 화면 시나리오가 없습니다 (화면 없음)" };
      const settings = visualSettings(ctx.config);
      const results = platforms.flatMap((p) => ids.map((id) => compareShot(root, id, p, settings)));
      // 비교 한 건마다 원장에 남긴다: 보고서가 첫 통과율과 차이 비율 분포를 본다
      for (const r of results) {
        record(ctx, `visual ${r.platform} ${r.scenario}`, r.ok ? 0 : 1, r.ok ? "pass" : "fail", false, describeVisual(r), r.platform, {
          scenario: r.scenario,
          tolerance: r.tolerance,
          ...(r.diffPercent !== undefined ? { diff_percent: r.diffPercent } : {}),
        });
      }
      const bad = results.filter((r) => !r.ok);
      return {
        name,
        ok: bad.length === 0,
        detail: `화면 비교 ${results.length}개 가운데 ${results.length - bad.length}개 통과:\n  - ${results.map(describeVisual).join("\n  - ")}`,
      };
    }
    case "no_new_skips": {
      const before = countAtRef(root, startRef).skips;
      const now = countWorktree(root).skips;
      return now <= before
        ? { name, ok: true, detail: "건너뛰기 표시가 새로 생기지 않았습니다" }
        : { name, ok: false, detail: `건너뛰기 표시(skip, todo, only 등)가 새로 생겼습니다: 작업 시작 때 ${before}개, 지금 ${now}개` };
    }
    case "tdd_order": {
      const mine = events.filter((e) => e.type === "node_end" && e.task === ctx.task && e.result === "pass");
      const red = mine.findIndex((e) => e.type === "node_end" && e.node === "N23");
      const green = mine.findLastIndex((e) => e.type === "node_end" && e.node === "N24");
      if (red >= 0 && green > red) return { name, ok: true, detail: "N23에서 실패하는 테스트를 쓴 뒤 N24에서 통과시켰습니다" };
      // 이미 충족된 작업은 구현을 바꾸지 않았으므로 TDD 순서를 따지지 않는다 (구현을 바꿨다면 위의 순서가 있어야 한다).
      const met = mine.some((e) => e.type === "node_end" && e.already_met);
      if (met && green < 0) return { name, ok: true, detail: "이미 충족된 작업이라 구현을 바꾸지 않았습니다 (TDD 순서 면제)" };
      return { name, ok: false, detail: "TDD 순서가 원장에 없습니다: N23(실패하는 단위 테스트)을 통과한 뒤 N24(구현)를 통과해야 합니다" };
    }
    case "locked_unchanged": {
      const d = baselineDiff(root, ctx.config);
      const changed = [...d.changed, ...d.added, ...d.removed];
      return changed.length
        ? { name, ok: false, detail: `잠긴 파일이 기준 해시와 다릅니다: ${changed.join(", ")}` }
        : { name, ok: true, detail: "잠긴 파일이 기준 해시와 같습니다" };
    }
    default:
      return planCheck(name, ctx, events);
  }
}

/** Stage 0·1의 검사 (조각 2). 기능(ctx.feature)을 본다. */
function planCheck(name: GateCheck, ctx: GateContext, events: LedgerEvent[]): GateCheckResult {
  const { root } = ctx;
  const f = ctx.feature;
  if (!f) return { name, ok: false, detail: `${name}: 어느 기능인지 모릅니다 (하네스 오류)` };
  const traceErrors = (mode: TraceMode) =>
    checkProject(root, "auto", { [f]: mode })
      .filter((t) => t.dir === `specs/${f}`)
      .flatMap((t) => t.issues.filter((i) => i.level === "error").map((i) => `${i.file}:${i.line} ${i.message}`));
  switch (name) {
    case "spec_sections": {
      const text = readText(root, featurePath(f, "spec.md"));
      if (text === null) return { name, ok: false, detail: `${featurePath(f, "spec.md")}이 없습니다` };
      const have = sections(text);
      const missing = SPEC_SECTIONS.filter((s) => !have.has(s));
      const reqs = parseSpec(text, "spec.md").requirements;
      const dup = traceErrors("scenarios").filter((m) => m.includes("다른 기능") && /\bR\d+가/.test(m));
      const problems = [
        ...(missing.length ? [`칸이 없습니다: ${missing.map((s) => `## ${s}`).join(", ")}`] : []),
        ...(reqs.length === 0 ? ["요구사항(- R4 …)이 하나도 없습니다"] : []),
        ...dup,
      ];
      return problems.length
        ? { name, ok: false, detail: `spec.md 형식: ${problems.join(" · ")}` }
        : { name, ok: true, detail: `spec.md: 요구사항 ${reqs.length}개, 물을 것 ${openQuestions(text).length}개` };
    }
    case "requirements_kept": {
      // Stage 2에서 스펙을 고치러 돌아왔을 때만: 요구사항을 더하거나 빼지 않는다 (조각 2 정한 것)
      if (!ctx.task) return { name, ok: true, detail: "처음 쓰는 스펙이라 해당 없음" };
      const packet = lastPacket(events, f, "0-1");
      if (!packet) return { name, ok: true, detail: "승인된 스펙(패킷 0 → 1)이 없어 비교하지 않습니다" };
      const before = packet.refs.filter((r) => /^R\d+$/.test(r)).sort();
      const now = featureIds(root, f).R.sort();
      const added = now.filter((r) => !before.includes(r));
      const removed = before.filter((r) => !now.includes(r));
      return added.length || removed.length
        ? { name, ok: false, detail: `Stage 2에서 돌아온 스펙은 요구사항을 더하거나 빼지 않습니다 (새 요구는 새 스토리로): 더함 ${added.join(", ") || "-"}, 뺌 ${removed.join(", ") || "-"}` }
        : { name, ok: true, detail: `요구사항 ${now.length}개가 승인 때와 같습니다` };
    }
    case "trace_scenarios":
    case "trace_full": {
      const errs = traceErrors(name === "trace_full" ? "full" : "scenarios");
      return errs.length
        ? { name, ok: false, detail: `추적 검사(${name === "trace_full" ? "요구사항·시나리오·작업" : "요구사항·시나리오"}) 오류:\n  - ${errs.join("\n  - ")}` }
        : { name, ok: true, detail: "추적 검사 통과" };
    }
    case "design_sections": {
      const text = readText(root, featurePath(f, "design.md"));
      if (text === null) return { name, ok: false, detail: `${featurePath(f, "design.md")}이 없습니다` };
      const have = sections(text);
      const missing = DESIGN_SECTIONS.filter((s) => !have.has(s));
      const ids = featureIds(root, f);
      const unmentioned = [...ids.R, ...ids.S].filter((id) => !new RegExp(`\\b${id}\\b`).test(text));
      const problems = [
        ...(missing.length ? [`칸이 없습니다: ${missing.map((s) => `## ${s}`).join(", ")}`] : []),
        ...(unmentioned.length ? [`설계에서 다루는 곳을 ID로 적지 않은 요구사항·시나리오: ${unmentioned.join(", ")}`] : []),
      ];
      return problems.length ? { name, ok: false, detail: `design.md: ${problems.join(" · ")}` } : { name, ok: true, detail: "design.md 칸과 ID가 모두 있습니다" };
    }
    case "sprint_goal": {
      const s = readSprint(root);
      if (!s) return { name, ok: false, detail: `${SPRINT_FILE}이 없습니다` };
      const problems = [
        ...(s.goal ? [] : ["## 목표에 한 문장이 있어야 합니다"]),
        ...(s.goal.split(/\r?\n/).filter((l) => l.trim()).length > 1 ? ["## 목표는 한 문장으로 씁니다"] : []),
        ...(s.features.includes(f) ? [] : [`## 기능에 ${f}가 없습니다`]),
      ];
      return problems.length ? { name, ok: false, detail: `sprint.md: ${problems.join(" · ")}` } : { name, ok: true, detail: `목표: ${s.goal}` };
    }
    case "backlog_ids": {
      const s = readSprint(root);
      if (!s) return { name, ok: false, detail: `${SPRINT_FILE}이 없습니다` };
      const traces = checkProject(root).filter((t) => s.features.includes(t.dir.split("/").pop() ?? ""));
      const tasks = new Map(traces.flatMap((t) => t.tasks.map((k) => [k.id, k] as const)));
      const unknown = s.backlog.filter((id) => !tasks.has(id));
      const done = s.backlog.filter((id) => tasks.get(id)?.done);
      const dups = s.backlog.filter((id, i) => s.backlog.indexOf(id) !== i);
      const left = [...tasks.values()].filter((k) => !k.done && !s.backlog.includes(k.id)).map((k) => k.id);
      const problems = [
        ...(s.backlog.length ? [] : ["## 백로그에 작업 ID가 없습니다"]),
        ...(unknown.length ? [`이번 스프린트 기능에 없는 작업: ${unknown.join(", ")}`] : []),
        ...(done.length ? [`이미 끝난 작업: ${done.join(", ")}`] : []),
        ...(dups.length ? [`두 번 넣은 작업: ${[...new Set(dups)].join(", ")}`] : []),
        ...(left.length ? [`백로그에 빠진 작업: ${left.join(", ")}`] : []),
      ];
      return problems.length ? { name, ok: false, detail: `백로그: ${problems.join(" · ")}` } : { name, ok: true, detail: `백로그: ${s.backlog.join(" → ")}` };
    }
    case "packet_unchanged": {
      const packet = lastPacket(events, f, "0-1");
      if (!packet) return { name, ok: false, detail: `${f}의 승인된 스펙과 시나리오(패킷 0 → 1)가 없습니다. N04 승인을 거쳐야 합니다` };
      const drift = packetDrift(root, packet);
      return drift.length
        ? { name, ok: false, detail: `N04에서 승인한 뒤 바뀐 파일이 있습니다: ${drift.join(", ")}` }
        : { name, ok: true, detail: `승인된 스펙과 시나리오 그대로입니다 (${packet.id})` };
    }
    // 조각 3: 디자인 산출물 (N00F, N03W, N03F)
    case "tokens_match":
      return { name, ...checkTokens(root) };
    case "code_connect_complete":
      return { name, ...checkCodeConnect(root) };
    case "states_complete":
      return f ? { name, ...checkStates(root, f) } : { name, ok: false, detail: "기능이 정해지지 않았습니다" };
    case "frames_complete":
      return f ? { name, ...checkFrames(root, f) } : { name, ok: false, detail: "기능이 정해지지 않았습니다" };
    case "app_builds": {
      // N00F: 디자인 시스템을 앱에 넣은 뒤에도 앱이 빌드되는가 (2026-11-27 실제 실행: 테마가 mobile/ 밖의 토큰을 가져다 써 번들이 깨졌는데 Stage 2에서야 드러남)
      const e2e = ctx.config.commands.e2e ?? {};
      const platform = (["web", "android"] as const).find((p) => e2e[p]?.build);
      if (!platform) return { name, ok: true, detail: "앱 빌드 명령(commands.e2e.<플랫폼>.build)이 없어 건너뜁니다" };
      const command = e2e[platform]!.build!;
      const r = runCommand(root, command, ctx.timeoutMs ?? GATE_TIMEOUT_MS);
      const run = record(ctx, command, r.exit, r.exit === 0 ? "pass" : "fail", false, r.output, platform, { seconds: r.seconds, build: true });
      return r.exit === 0
        ? { name, ok: true, detail: `${platform} 앱이 빌드됩니다 (${r.seconds}초)` }
        : { name, ok: false, detail: `${platform} 앱 빌드 \`${command}\`가 깨졌습니다 (종료 코드 ${r.exit}, 출력 ${run.log}). 디자인 시스템(테마, 부품, 글꼴)을 넣은 뒤에도 앱이 빌드되어야 합니다` };
    }
    default:
      return { name, ok: false, detail: `알 수 없는 검사입니다: ${name}` };
  }
}

export function runGate(ctx: GateContext): GateOutcome {
  const node = getNode(ctx.nodes, ctx.nodeId);
  const gate = node.gate;
  if (!gate) throw new Error(`${ctx.nodeId}에는 관문이 없습니다`);
  const timeoutMs = ctx.timeoutMs ?? GATE_TIMEOUT_MS;
  const commands = gate.run === undefined ? [] : Array.isArray(gate.run) ? gate.run : [gate.run];
  // 화면 기능의 작업이면 시나리오 파일을 받는 명령 대신 플랫폼마다 platform_run을 돌린다 (조각 3)
  const platforms = gate.platform_run ? taskPlatforms(ctx.root, ctx.config, ctx.task) : [];
  const base = ctx.task ? taskScenarios(ctx.root, ctx.task) : { ids: [], files: [] };
  const perPlatform = platforms.map((p) => ({ platform: p, ...platformScenarios(ctx.root, ctx.task!, p) }));
  // 검사(시나리오마다 테스트가 있음)가 보는 목록: 화면 기능이면 플랫폼마다의 플로우 파일
  const scenarios = platforms.length ? { ids: perPlatform.flatMap((x) => x.ids), files: perPlatform.flatMap((x) => x.files) } : base;
  const platformRun = gate.platform_run === undefined ? [] : Array.isArray(gate.platform_run) ? gate.platform_run : [gate.platform_run];
  const planned: { template: string; files: string[]; platform?: Platform }[] = platforms.length
    ? [
        ...commands.filter((c) => !c.includes("{task.scenario_files}")).map((template) => ({ template, files: [] as string[] })),
        // 빌드 명령이 없는 플랫폼(예: 테스트가 서버와 웹을 스스로 띄움)은 빌드 단계를 건너뛴다
        ...perPlatform
          // 플랫폼 전체를 돌리는 관문(N28)인데 그 플랫폼에 플로우가 아직 하나도 없으면(서버만 바꾸는 첫 작업) 빌드도 하지 않는다
          .filter((x) => !platformRun.some((t) => t.includes("{platform.all_files}")) || allE2eFiles(ctx.root, x.platform).length > 0)
          .flatMap((x) =>
            platformRun
              .filter((template) => !template.includes("{e2e.build}") || !!ctx.config.commands.e2e?.[x.platform]?.build)
              .map((template) => ({ template, files: x.files, platform: x.platform })),
          ),
      ]
    : commands.map((template) => ({ template, files: base.files }));

  if (planned.some((c) => c.template.includes("{task.scenario_files}")) && base.ids.length === 0) {
    return { node: ctx.nodeId, passed: true, runs: [], checks: [], summary: `${ctx.nodeId}: 이 작업에서 통과시킬 시나리오가 없어 관문을 건너뜁니다` };
  }

  // 구현이 이미 있는 작업으로 다시 돌아왔으면(test_flaky를 고치러 오거나 스펙을 고친 뒤) "처음엔 실패"를 요구할 수 없다.
  const specChanged = gate.reentry === "spec_changed" && !!ctx.task && specReapproved(readEvents(ctx.root).events, ctx.task, ctx.nodeId);
  const testsAfter = gate.expect === "fail" && !!ctx.task && reviewAskedTests(readEvents(ctx.root).events, ctx.task, ctx.nodeId);
  const reentry =
    specChanged ||
    testsAfter ||
    (gate.reentry === "any" &&
      !!ctx.task &&
      readEvents(ctx.root).events.some((e) => e.type === "node_end" && e.task === ctx.task && e.node === "N24" && e.result === "pass"));
  const runs: GateRunResult[] = [];
  let cause: Cause | undefined;
  const brokenBuild = new Set<Platform>();
  // 처음엔 실패해야 하는 노드(N22)는 앱 코드를 고칠 수 없다. 그때 빌드가 깨져 있으면 다시 해도 소용없으므로 사람에게 넘긴다 (2026-11-27 실제 실행)
  let buildBlocked = false;
  for (const step of planned) {
    if (step.platform && brokenBuild.has(step.platform)) continue;
    const command = expand(step.template, ctx.config, step.files, step.platform, ctx.root);
    // 앱 빌드({e2e.build})는 기대(실패해야 함)와 상관없이 성공해야 한다. 빌드가 깨지면 그 플랫폼의 테스트를 돌리지 않는다
    const isBuild = step.template.includes("{e2e.build}");
    // 플로우 파일을 받는 플랫폼 명령은 파일 수만큼 시간을 더 준다
    const stepTimeout =
      step.platform && !isBuild && step.files.length ? timeoutMs + step.files.length * (ctx.config.commands.e2e?.[step.platform]?.flow_seconds ?? FLOW_SECONDS[step.platform]) * 1000 : timeoutMs;
    let r = runCommand(ctx.root, command, stepTimeout);
    const envProblem = r.timedOut || r.exit === 126 || r.exit === 127;
    const met = (exit: number) => (isBuild ? exit === 0 : reentry || (gate.expect === "pass" ? exit === 0 : exit !== 0));
    if (envProblem) {
      runs.push(record(ctx, command, r.exit, "fail", false, r.output, step.platform, { seconds: r.seconds, ...(isBuild ? { build: true } : {}), ...(r.timedOut ? { timedOutSec: Math.max(1, Math.round(stepTimeout / 1000)) } : {}) }));
      cause = "env";
      continue;
    }
    runs.push(record(ctx, command, r.exit, met(r.exit) ? "pass" : "fail", false, r.output, step.platform, { seconds: r.seconds, ...(isBuild ? { build: true } : {}) }));
    if (isBuild && r.exit !== 0) {
      if (step.platform) brokenBuild.add(step.platform);
      if (gate.expect === "fail") {
        buildBlocked = true;
        cause = "env";
      }
      continue;
    }
    if (!met(r.exit) && gate.flaky_rerun && gate.expect === "pass") {
      // test_flaky: 한 번 다시 돌려 결과가 바뀌면 테스트가 불안정한 것이다. 이 재실행은 횟수에 넣지 않는다.
      r = runCommand(ctx.root, command, stepTimeout);
      runs.push(record(ctx, command, r.exit, met(r.exit) ? "pass" : "fail", true, r.output, step.platform, { seconds: r.seconds }));
      if (met(r.exit)) cause = "test_flaky";
    }
  }

  const { events } = readEvents(ctx.root);
  const checks = (gate.checks ?? []).map((name) => runCheck(name, ctx, scenarios, events, specChanged));

  const lastRuns = runs.filter((r, i) => !(runs[i + 1]?.flakyRerun && runs[i + 1].command === r.command));
  const runsOk = lastRuns.every((r) => r.result === "pass") && cause === undefined;
  const checksOk = checks.every((c) => c.ok);
  // 이미 충족: 실패해야 하는 명령이 처음부터 통과했고(앞 작업이 이미 구현함), 다른 검사(시나리오마다 테스트가 있음)는 통과했다.
  const alreadyMet =
    !!gate.already_met && gate.expect === "fail" && !reentry && cause === undefined && checksOk && lastRuns.length > 0 && lastRuns.every((r) => r.exit === 0);
  const passed = (runsOk && checksOk) || alreadyMet;
  if (alreadyMet) {
    const summary = `${ctx.nodeId} 이미 충족: 작업의 시나리오(${scenarios.ids.map((s) => `@${s}`).join(", ")})가 앞 작업의 구현으로 이미 통과합니다. N23~N25를 건너뛰고 ${gate.already_met}로 갑니다. N27 리뷰가 이 테스트가 시나리오를 제대로 확인하는지 봅니다`;
    mkdirSync(join(ctx.root, GATE_DIR), { recursive: true });
    writeFileSync(join(ctx.root, GATE_DIR, `${ctx.runId}.summary.md`), summary + "\n", "utf8");
    return { node: ctx.nodeId, passed: true, alreadyMet: true, runs, checks, summary };
  }

  const lines: string[] = [];
  for (const r of runs) {
    if (r.result === "pass") continue;
    if (r.flakyRerun && cause === "test_flaky") continue;
    if (r.timedOutSec) {
      const limit = r.timedOutSec >= 60 ? `${Math.round(r.timedOutSec / 6) / 10}분` : `${r.timedOutSec}초`;
      lines.push(`명령 \`${r.command}\`이 시간 제한 ${limit}을 넘어 끊었습니다 (출력 ${r.log})`);
      continue;
    }
    if (r.build) {
      lines.push(`앱 빌드 \`${r.command}\`가 깨졌습니다 (종료 코드 ${r.exit}, 출력 ${r.log}). 이 플랫폼의 플로우는 돌리지 않았습니다`);
      continue;
    }
    const want = gate.expect === "pass" ? "통과해야 하는데 실패했습니다" : "실패해야 하는데 통과했습니다 (아직 구현이 없는데 통과하면 테스트가 동작을 확인하지 않는 것입니다)";
    lines.push(`명령 \`${r.command}\`이 ${want} (종료 코드 ${r.exit}, 출력 ${r.log})`);
  }
  if (cause === "test_flaky") lines.push("같은 코드로 다시 돌렸더니 결과가 바뀌었습니다: 테스트가 불안정합니다 (test_flaky)");
  if (buildBlocked) lines.push(`${ctx.nodeId}는 앱 코드를 고칠 수 없어, 깨진 빌드를 사람에게 넘깁니다 (env: 빌드 설정이나 앞 작업을 봐야 함)`);
  else if (cause === "env") lines.push("명령을 실행하지 못했거나 시간 제한을 넘었습니다: 실행 환경 문제입니다 (env)");
  for (const c of checks) if (!c.ok) lines.push(c.detail);
  const summary = passed ? `${ctx.nodeId} 관문 통과` : `${ctx.nodeId} 관문 실패\n- ${lines.join("\n- ")}`;
  mkdirSync(join(ctx.root, GATE_DIR), { recursive: true });
  writeFileSync(join(ctx.root, GATE_DIR, `${ctx.runId}.summary.md`), summary + "\n", "utf8");
  return { node: ctx.nodeId, passed, ...(cause ? { cause } : {}), runs, checks, summary };
}
