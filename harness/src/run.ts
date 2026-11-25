// 4dd run: 지휘 프로그램 (첫 구현 조각 명세 「구조」)
//
// 원장으로 다음 할 일을 정하고(route.ts), 노드를 맡는 쪽에 따라 돌리고, 통과한 노드마다 커밋한다.
// 에이전트는 다음 노드로 넘어가거나 판정하지 않는다. 사람이 필요하면 멈추고 기다린다.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adapterFor, type Adapter, type Agent } from "./adapters.ts";
import { loadConfig, type Config } from "./config.ts";
import { classifyFailure } from "./classify.ts";
import { GATE_DIR, runGate, taskScenarios } from "./gate.ts";
import { git } from "./git.ts";
import { appendEvent, nextId, readEvents, type LedgerEvent } from "./ledger.ts";
import { baselineDiff, computeBaseline, writeBaseline } from "./lock.ts";
import { allowedCauses, budgetFor, getNode, loadNodes, type Cause, type NodeSet } from "./nodes.ts";
import { decideNext } from "./route.ts";
import { loadState, type State } from "./state.ts";
import { checkProject, type FeatureTrace } from "./trace.ts";
import { runReviewNode, runSessionNode } from "./turn.ts";

export interface RunOptions {
  root: string;
  agent?: Agent;
  adapter?: Adapter;
  /** 이만큼 작업을 끝내면 멈춘다 */
  maxTasks?: number;
  /** 무한 루프를 막는 노드 수 한도 */
  maxSteps?: number;
  /** 노드마다 한 줄씩 알린다 */
  log?: (line: string) => void;
}

export interface RunOutcome {
  /** paused는 작업 수 한도로 잠시 멈춤, stopped는 사람이 고치고 승인해야 다시 감 */
  reason: "done" | "wait_human" | "paused" | "stopped" | "error";
  message: string;
  run: string | null;
}

export function waitingMessage(s: State): string {
  const w = s.waiting;
  const where = w ? `${w.task ?? "-"}의 ${w.node}에서 ${w.reason}` : `${s.task ?? "-"}의 ${s.node ?? "-"}`;
  return [
    `사람을 기다립니다: ${where}`,
    "할 수 있는 것:",
    '  4dd human hint "<힌트>"       힌트를 주고 다시 시도',
    "  4dd human approve            스펙·설계를 고쳤거나 그대로 진행해도 될 때 (잠긴 파일의 기준 해시를 새로 고정)",
    "  4dd human reclassify <원인>  실패 원인을 바로잡기",
    "  4dd human hold               이 작업을 보류하고 다음 작업으로",
  ].join("\n");
}

function featureTrace(root: string, task: string | null): FeatureTrace | undefined {
  const traces = checkProject(root);
  return (task && traces.find((t) => t.tasks.some((x) => x.id === task))) || traces[0];
}

/** 통과한 노드를 커밋한다. 트레일러로 원장과 코드를 잇는다. */
export function commitNode(root: string, nodes: NodeSet, node: string, task: string | null, runId: string, title: string): string {
  git(root, ["add", "-A"]);
  const refs = task ? [...(featureTrace(root, task)?.tasks.find((t) => t.id === task)?.reqs ?? []), ...taskScenarios(root, task).ids] : [];
  const message = [`${node}${task ? ` ${task}` : ""}: ${title}`, "", `4DD-Node: ${node}`, ...(task ? [`4DD-Task: ${task}`] : []), ...(refs.length ? [`4DD-Refs: ${refs.join(",")}`] : []), `4DD-Run: ${runId}`].join("\n");
  git(root, ["commit", "-q", "--allow-empty", "-m", message], { FOURDD_NODE: node, FOURDD_NODE_RUN: runId });
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  appendEvent(root, nodes.version, { type: "commit", sha, node, task });
  return sha;
}

function needHuman(root: string, nodes: NodeSet, runId: string, node: string, cause: Cause): void {
  appendEvent(root, nodes.version, { type: "classify", run: runId, node, cause, by: "harness", needs_human: true });
}

/** N21: tasks.md에서 체크되지 않은 첫 작업을 고른다. 없으면 null. */
function pickTask(root: string, nodes: NodeSet, state: State): { task: string; runId: string } | null {
  const trace = featureTrace(root, null);
  const skip = new Set([...state.done_tasks, ...state.held_tasks]);
  const t = trace?.tasks.find((x) => !x.done && !skip.has(x.id));
  if (!t) return null;
  const { events } = readEvents(root);
  const runId = nextId(events, "NR");
  appendEvent(root, nodes.version, { type: "node_start", id: runId, node: "N21", task: null, session: null });
  appendEvent(root, nodes.version, { type: "node_end", id: runId, node: "N21", task: t.id, result: "pass", minutes: 0 });
  commitNode(root, nodes, "N21", t.id, runId, `작업 선택: ${t.title}`);
  return { task: t.id, runId };
}

/** N29: 작업을 체크하고 기준 해시를 새로 적는다 (tasks.md의 체크만 바뀜). */
function completeTask(root: string, nodes: NodeSet, config: Config, task: string): string {
  const trace = featureTrace(root, task);
  if (!trace) throw new Error(`${task}가 있는 기능을 찾지 못했습니다`);
  const file = join(root, trace.dir, "tasks.md");
  const text = readFileSync(file, "utf8");
  const checked = text.replace(new RegExp(`^(\\s*[-*]\\s+\\[) (\\]\\s+${task}\\b)`, "m"), "$1x$2");
  writeFileSync(file, checked);
  const { events } = readEvents(root);
  const runId = nextId(events, "NR");
  appendEvent(root, nodes.version, { type: "node_start", id: runId, node: "N29", task, session: null });
  writeBaseline(root, computeBaseline(root, config));
  appendEvent(root, nodes.version, { type: "node_end", id: runId, node: "N29", task, result: "pass", task_done: true, minutes: 0 });
  commitNode(root, nodes, "N29", task, runId, "작업 완료 체크");
  return runId;
}

/** 하네스가 직접 판정하는 노드 (N26, N28). 실패하면 원인을 정한다: 기계가 정하거나, 그 작업의 세션이 고르거나, 기본 원인. */
function runHarnessDecision(root: string, nodes: NodeSet, config: Config, nodeId: string, task: string, adapter: Adapter, session: string | null) {
  const { events } = readEvents(root);
  const runId = nextId(events, "NR");
  appendEvent(root, nodes.version, { type: "node_start", id: runId, node: nodeId, task, session: null });
  const t0 = Date.now();
  const gate = runGate({ root, config, nodes, nodeId, task, runId });
  const c = gate.passed ? undefined : classifyFailure({ root, nodes, nodeId, task, runId, ...(gate.cause ? { machineCause: gate.cause } : {}), gateSummary: gate.summary, session, adapter });
  const minutes = Math.round(((Date.now() - t0) / 60_000) * 100) / 100;
  const t = c?.turn;
  appendEvent(root, nodes.version, {
    type: "node_end",
    id: runId,
    node: nodeId,
    task,
    result: gate.passed ? "pass" : "fail",
    ...(c ? { cause: c.cause } : {}),
    ...(t?.tokens ? { tokens: t.tokens } : {}),
    ...(t?.costUsd !== undefined ? { cost_usd: t.costUsd } : {}),
    minutes,
  });
  if (c) {
    appendEvent(root, nodes.version, { type: "classify", run: runId, node: nodeId, cause: c.cause, by: c.by, needs_human: c.needsHuman });
    if (c.evidence) writeFileSync(join(root, GATE_DIR, `${runId}.summary.md`), `${gate.summary}\n\n실패 원인: ${c.cause} (${c.by === "agent" ? "에이전트" : "하네스"}가 정함)\n근거: ${c.evidence}\n`, "utf8");
  }
  return { runId, passed: gate.passed, cause: c?.cause, needsHuman: c?.needsHuman ?? false, summary: gate.summary };
}

const lastNodeEnd = (events: LedgerEvent[]) => events.filter((e) => e.type === "node_end").at(-1);

/** 던지는 대신 Error를 돌려준다 (루프가 멈출 이유로 쓴다) */
function attempt<T>(fn: () => T): T | Error {
  try {
    return fn();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    return new Error(String(err.stderr || err.message).trim().slice(0, 600));
  }
}

export function runLoop(opts: RunOptions): RunOutcome {
  const root = resolve(opts.root);
  const config = loadConfig(root);
  const nodes = loadNodes();
  const H = nodes.version;
  const agent = opts.agent ?? config.agent;
  const adapter = opts.adapter ?? adapterFor(agent);
  const log = opts.log ?? (() => {});
  const maxSteps = opts.maxSteps ?? 200;

  let state = loadState(root).state;
  if (state.status === "waiting_human") return { reason: "wait_human", message: waitingMessage(state), run: null };
  if (state.status === "stopped") return { reason: "stopped", message: "중단된 상태입니다. 원인을 고친 뒤 4dd human approve로 다시 시작합니다", run: null };

  const run = nextId(readEvents(root).events, "RUN");
  appendEvent(root, H, { type: "run_start", run, agent, feature: featureTrace(root, state.task)?.dir.split("/").pop() ?? "-" });
  let tasksDone = 0;
  const finish = (reason: RunOutcome["reason"], message: string): RunOutcome => {
    appendEvent(root, H, { type: "run_end", run, reason });
    loadState(root);
    return { reason, message, run };
  };

  for (let i = 0; i < maxSteps; i++) {
    state = loadState(root).state;
    const { events } = readEvents(root);
    const step = decideNext(events, nodes, config.work_type, state);

    if (step.kind === "human") {
      if (state.status !== "waiting_human") {
        const end = lastNodeEnd(events);
        needHuman(root, nodes, end?.type === "node_end" ? end.id : "NR0", step.node, (step.reason === "stopped" ? "env" : step.reason) as Cause);
      }
      return finish("wait_human", waitingMessage(loadState(root).state));
    }

    // 재사용 전 검증: 노드나 작업 선택을 시작할 때마다 잠긴 파일이 기준 해시와 같은지 본다. 다르면 기준이 승인 없이 바뀐 것이다.
    const d = baselineDiff(root, config);
    const drift = [...d.changed, ...d.added, ...d.removed];
    if (drift.length) return finish("stopped", `잠긴 파일이 기준 해시와 다릅니다: ${drift.join(", ")}. 되돌리거나, 맞으면 4dd human approve로 기준을 새로 고정합니다`);

    if (step.kind === "pick") {
      if (opts.maxTasks !== undefined && tasksDone >= opts.maxTasks) return finish("paused", `작업 ${tasksDone}개를 끝내고 멈췄습니다 (--max-tasks). 4dd run으로 이어 갑니다`);
      const picked = attempt(() => pickTask(root, nodes, state));
      if (picked instanceof Error) return finish("stopped", `작업을 고르다 멈췄습니다: ${picked.message}`);
      if (!picked) return finish("done", "남은 작업이 없습니다. Stage 2 끝");
      log(`N21 ${picked.task}을 골랐습니다`);
      continue;
    }

    const nodeId = step.node;
    const task = state.task;
    if (!task) return finish("error", `작업 없이 ${nodeId}에 왔습니다`);
    const node = getNode(nodes, nodeId);

    if (nodeId === "N29") {
      const done = attempt(() => completeTask(root, nodes, config, task));
      if (done instanceof Error) return finish("stopped", `작업 완료 체크에서 멈췄습니다: ${done.message}`);
      tasksDone++;
      log(`N29 ${task} 완료`);
      continue;
    }

    let runId: string;
    let passed: boolean;
    let cause: Cause | undefined;
    let stop: string | undefined;
    let summary: string;
    if (node.actor === "worker") {
      const r = runSessionNode({ root, config, nodes, nodeId, task, adapter });
      ({ runId, passed, cause, stop, summary } = r);
      const t = r.turn;
      log(`${nodeId} ${task} ${passed ? "통과" : stop ? "멈춤" : "실패"} · ${t.minutes}분${t.costUsd !== undefined ? ` · $${t.costUsd.toFixed(3)}` : ""}`);
    } else if (node.actor === "reviewer") {
      const r = runReviewNode({ root, config, nodes, nodeId, task, adapter });
      ({ runId, passed, cause, stop, summary } = r);
      log(`${nodeId} ${task} ${passed ? "통과" : stop ? "멈춤" : `실패 (${cause})`} · ${r.turn.minutes}분${r.turn.costUsd !== undefined ? ` · $${r.turn.costUsd.toFixed(3)}` : ""}`);
    } else {
      const r = runHarnessDecision(root, nodes, config, nodeId, task, adapter, state.session);
      ({ runId, passed, cause, summary } = r);
      stop = undefined;
      log(`${nodeId} ${task} ${passed ? "통과" : `실패 (${cause})`}`);
      if (!passed && r.needsHuman && cause !== "env") return finish("wait_human", `${summary}\n${waitingMessage(loadState(root).state)}`);
    }

    if (stop) {
      needHuman(root, nodes, runId, nodeId, "env");
      return finish("wait_human", `${summary}\n${waitingMessage(loadState(root).state)}`);
    }
    if (passed) {
      // 커밋이 막히면(pre-commit이 잠금 위반을 찾음) 하네스가 모르는 변경이 섞인 것이다. 멈추고 사람에게 알린다.
      const sha = attempt(() => commitNode(root, nodes, nodeId, task, runId, node.name));
      if (sha instanceof Error) return finish("stopped", `${nodeId} 커밋이 막혔습니다: ${sha.message}`);
      continue;
    }
    // 실패: 실행 환경 문제면 사람, 아니면 횟수 제한을 본다. 리뷰 세션의 사람 원인(arch_wrong)은 runReviewNode가 이미 기다리게 했다.
    if (cause === "env") {
      if (loadState(root).state.status !== "waiting_human") needHuman(root, nodes, runId, nodeId, "env");
      return finish("wait_human", `${summary}\n${waitingMessage(loadState(root).state)}`);
    }
    const s = loadState(root).state;
    if (s.status === "waiting_human") return finish("wait_human", `${summary}\n${waitingMessage(s)}`);
    if ((s.fails[nodeId] ?? 0) >= budgetFor(nodes, nodeId) || s.task_backtracks >= nodes.defaults.task_budget) {
      needHuman(root, nodes, runId, nodeId, "budget_exceeded");
      return finish("wait_human", `횟수 제한을 넘었습니다 (${nodeId} 연속 ${s.fails[nodeId] ?? 0}번, 작업 전체 ${s.task_backtracks}번)\n${summary}\n${waitingMessage(loadState(root).state)}`);
    }
  }
  return finish("error", `노드 ${maxSteps}개를 돌아도 끝나지 않아 멈췄습니다`);
}
