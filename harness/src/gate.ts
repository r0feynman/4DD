// 관문: 노드가 끝났는지 기계가 판정한다 (하네스 설계 ⑤ 「관문 계약」, 첫 구현 조각 명세 「노드마다 누가 무엇을」).
//
// 관문은 지휘 프로그램이 직접 돌린다. 에이전트는 판정하지 않는다.
// 명령마다 관문 실행 기록(gate_run)을 원장에 남기고, 출력은 .4dd/gates/<ID>.log에 둔다(원장에는 ID만).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { appendEvent, DIR, nextId, readEvents, type LedgerEvent } from "./ledger.ts";
import { baselineDiff } from "./lock.ts";
import { getNode, GATE_CHECKS, type Cause, type NodeSet } from "./nodes.ts";
import { countAtRef, countSource, countWorktree } from "./testscan.ts";
import { checkProject, scenariosForTask } from "./trace.ts";

export const GATE_DIR = `${DIR}/gates`;
export const GATE_TIMEOUT_MS = 10 * 60_000;
export const ACCEPTANCE_DIR = "tests/acceptance";
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export type GateCheck = (typeof GATE_CHECKS)[number];

export interface GateContext {
  root: string;
  config: Config;
  nodes: NodeSet;
  nodeId: string;
  task: string | null;
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
}

/** 작업의 시나리오와 인수 테스트 파일. 파일이 아직 없으면 정해진 이름(tests/acceptance/S1.test.ts)을 준다. */
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

function expand(template: string, config: Config, scenarioFiles: string[]): string {
  return template
    .replace(/\{commands\.(\w+)\}/g, (_, k: string) => {
      const v = (config.commands as Record<string, string | undefined>)[k];
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

function runCommand(root: string, command: string, timeoutMs: number): { exit: number; output: string; timedOut: boolean } {
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
  return { exit, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut };
}

function record(ctx: GateContext, command: string, exit: number, result: "pass" | "fail", flakyRerun: boolean, output: string): GateRunResult {
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
    ...(tests ? { tests } : {}),
  });
  return { id, command, exit, result, flakyRerun, log };
}

function runCheck(name: GateCheck, ctx: GateContext, scenarios: { ids: string[]; files: string[] }, events: LedgerEvent[]): GateCheckResult {
  const { root } = ctx;
  const startRef = taskStartRef(events, ctx.task);
  switch (name) {
    case "scenario_files_exist": {
      const missing = scenarios.ids.filter((id, i) => {
        const f = join(root, scenarios.files[i]);
        return !existsSync(f) || countSource(readFileSync(f, "utf8")).tests === 0;
      });
      return missing.length
        ? { name, ok: false, detail: `시나리오마다 인수 테스트가 있어야 합니다. 없거나 테스트가 비어 있는 시나리오: ${missing.map((id) => `@${id} (${ACCEPTANCE_DIR}/${id}.test.ts)`).join(", ")}` }
        : { name, ok: true, detail: `시나리오 ${scenarios.ids.length}개의 인수 테스트가 있습니다` };
    }
    case "new_tests": {
      const before = countAtRef(root, "HEAD", "tests/unit").tests;
      const now = countWorktree(root, "tests/unit").tests;
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
      return red >= 0 && green > red
        ? { name, ok: true, detail: "N23에서 실패하는 테스트를 쓴 뒤 N24에서 통과시켰습니다" }
        : { name, ok: false, detail: "TDD 순서가 원장에 없습니다: N23(실패하는 단위 테스트)을 통과한 뒤 N24(구현)를 통과해야 합니다" };
    }
    case "locked_unchanged": {
      const d = baselineDiff(root, ctx.config);
      const changed = [...d.changed, ...d.added, ...d.removed];
      return changed.length
        ? { name, ok: false, detail: `잠긴 파일이 기준 해시와 다릅니다: ${changed.join(", ")}` }
        : { name, ok: true, detail: "잠긴 파일이 기준 해시와 같습니다" };
    }
  }
}

export function runGate(ctx: GateContext): GateOutcome {
  const node = getNode(ctx.nodes, ctx.nodeId);
  const gate = node.gate;
  if (!gate) throw new Error(`${ctx.nodeId}에는 관문이 없습니다`);
  const timeoutMs = ctx.timeoutMs ?? GATE_TIMEOUT_MS;
  const scenarios = ctx.task ? taskScenarios(ctx.root, ctx.task) : { ids: [], files: [] };
  const commands = Array.isArray(gate.run) ? gate.run : [gate.run];

  if (commands.some((c) => c.includes("{task.scenario_files}")) && scenarios.files.length === 0) {
    return { node: ctx.nodeId, passed: true, runs: [], checks: [], summary: `${ctx.nodeId}: 이 작업에서 통과시킬 시나리오가 없어 관문을 건너뜁니다` };
  }

  const runs: GateRunResult[] = [];
  let cause: Cause | undefined;
  for (const template of commands) {
    const command = expand(template, ctx.config, scenarios.files);
    let r = runCommand(ctx.root, command, timeoutMs);
    const envProblem = r.timedOut || r.exit === 126 || r.exit === 127;
    const met = (exit: number) => (gate.expect === "pass" ? exit === 0 : exit !== 0);
    if (envProblem) {
      runs.push(record(ctx, command, r.exit, "fail", false, r.output));
      cause = "env";
      continue;
    }
    runs.push(record(ctx, command, r.exit, met(r.exit) ? "pass" : "fail", false, r.output));
    if (!met(r.exit) && gate.flaky_rerun && gate.expect === "pass") {
      // test_flaky: 한 번 다시 돌려 결과가 바뀌면 테스트가 불안정한 것이다. 이 재실행은 횟수에 넣지 않는다.
      r = runCommand(ctx.root, command, timeoutMs);
      runs.push(record(ctx, command, r.exit, met(r.exit) ? "pass" : "fail", true, r.output));
      if (met(r.exit)) cause = "test_flaky";
    }
  }

  const { events } = readEvents(ctx.root);
  const checks = (gate.checks ?? []).map((name) => runCheck(name, ctx, scenarios, events));

  const lastRuns = runs.filter((r, i) => !(runs[i + 1]?.flakyRerun && runs[i + 1].command === r.command));
  const runsOk = lastRuns.every((r) => r.result === "pass") && cause === undefined;
  const passed = runsOk && checks.every((c) => c.ok);

  const lines: string[] = [];
  for (const r of runs) {
    if (r.result === "pass") continue;
    if (r.flakyRerun && cause === "test_flaky") continue;
    const want = gate.expect === "pass" ? "통과해야 하는데 실패했습니다" : "실패해야 하는데 통과했습니다 (아직 구현이 없는데 통과하면 테스트가 동작을 확인하지 않는 것입니다)";
    lines.push(`명령 \`${r.command}\`이 ${want} (종료 코드 ${r.exit}, 출력 ${r.log})`);
  }
  if (cause === "test_flaky") lines.push("같은 코드로 다시 돌렸더니 결과가 바뀌었습니다: 테스트가 불안정합니다 (test_flaky)");
  if (cause === "env") lines.push("명령을 실행하지 못했거나 시간 제한을 넘었습니다: 실행 환경 문제입니다 (env)");
  for (const c of checks) if (!c.ok) lines.push(c.detail);
  const summary = passed ? `${ctx.nodeId} 관문 통과` : `${ctx.nodeId} 관문 실패\n- ${lines.join("\n- ")}`;
  mkdirSync(join(ctx.root, GATE_DIR), { recursive: true });
  writeFileSync(join(ctx.root, GATE_DIR, `${ctx.runId}.summary.md`), summary + "\n", "utf8");
  return { node: ctx.nodeId, passed, ...(cause ? { cause } : {}), runs, checks, summary };
}
