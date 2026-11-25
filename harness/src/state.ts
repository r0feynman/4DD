// 현재 상태 .4dd/state.json (하네스 설계 ② 4층의 맨 아래 층)
//
// state.json은 원장을 차례로 접어서 만든다. 언제든 원장에서 다시 만들 수 있으므로,
// 지휘 프로그램이나 세션이 죽어도 그 자리부터 이어 갈 수 있다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, readEvents, type LedgerEvent } from "./ledger.ts";

export const STATE_FILE = "state.json";
export const STATE_SCHEMA_VERSION = 1;
export const statePath = (root: string) => join(root, DIR, STATE_FILE);

export type Status = "idle" | "running" | "waiting_human" | "done" | "stopped";

export interface State {
  schema_version: number;
  /** 마지막 이벤트를 쓴 하네스 버전 */
  harness: string | null;
  run: string | null;
  agent: "claude" | "codex" | null;
  feature: string | null;
  status: Status;
  task: string | null;
  node: string | null;
  /** 지금 노드 실행의 ID (NR…) */
  node_run: string | null;
  /** 작업 세션 ID. 같은 작업 안에서는 이어 쓰고, 작업이 바뀌면 비운다 */
  session: string | null;
  /** 지금 작업에서 노드별 연속 실패 수. 통과하면 0 */
  fails: Record<string, number>;
  /** 지금 작업의 되돌림 총합 */
  task_backtracks: number;
  /** 사람을 기다리는 이유 */
  waiting: { node: string; task: string | null; reason: string } | null;
  /** 마지막으로 실패한 관문 실행 기록 (다음 차례의 맥락에 붙임) */
  last_gate: string | null;
  done_tasks: string[];
  held_tasks: string[];
  /** 접은 이벤트 수. 원장이 이보다 길면 state.json이 낡은 것이다 */
  events: number;
  updated_at: string | null;
}

export function initialState(): State {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    harness: null,
    run: null,
    agent: null,
    feature: null,
    status: "idle",
    task: null,
    node: null,
    node_run: null,
    session: null,
    fails: {},
    task_backtracks: 0,
    waiting: null,
    last_gate: null,
    done_tasks: [],
    held_tasks: [],
    events: 0,
    updated_at: null,
  };
}

/** 새 작업으로 넘어갈 때 작업 단위 값을 비운다. */
function enterTask(s: State, task: string): void {
  if (s.task === task) return;
  s.task = task;
  s.session = null;
  s.fails = {};
  s.task_backtracks = 0;
  s.last_gate = null;
}

/** 이벤트 하나를 상태에 접는다. 원래 상태는 바꾸지 않는다. */
export function reduce(prev: State, e: LedgerEvent): State {
  const s: State = structuredClone(prev);
  s.events += 1;
  s.updated_at = e.ts;
  s.harness = e.harness;

  switch (e.type) {
    case "run_start":
      s.run = e.run;
      s.agent = e.agent;
      s.feature = e.feature;
      if (s.status !== "waiting_human") s.status = "running";
      break;
    case "node_start":
      if (e.task) enterTask(s, e.task);
      s.node = e.node;
      s.node_run = e.id;
      if (e.session) s.session = e.session;
      break;
    case "node_end":
      if (e.task) enterTask(s, e.task);
      if (e.session) s.session = e.session;
      if (e.result === "fail") {
        s.fails[e.node] = (s.fails[e.node] ?? 0) + 1;
        s.task_backtracks += 1;
      } else if (e.result === "pass") {
        s.fails[e.node] = 0;
      }
      if (e.task_done && s.task) {
        if (!s.done_tasks.includes(s.task)) s.done_tasks.push(s.task);
        s.task = null;
        s.session = null;
        s.fails = {};
        s.task_backtracks = 0;
        s.last_gate = null;
      }
      break;
    case "gate_run":
      s.last_gate = e.result === "fail" ? e.id : null;
      break;
    case "classify":
      if (e.needs_human) {
        s.status = "waiting_human";
        s.waiting = { node: e.node, task: s.task, reason: e.cause };
      }
      break;
    case "human":
      if (e.kind === "hold") {
        if (e.task && !s.held_tasks.includes(e.task)) s.held_tasks.push(e.task);
        s.task = null;
        s.node = null;
        s.node_run = null;
        s.session = null;
        s.fails = {};
        s.task_backtracks = 0;
        s.last_gate = null;
        s.status = "idle";
      } else {
        // 사람이 승인하거나 힌트를 주면 그 노드와 작업의 횟수를 새로 준다.
        s.fails[e.node] = 0;
        s.task_backtracks = 0;
        s.status = "running";
      }
      s.waiting = null;
      break;
    case "run_end":
      if (e.reason === "done") s.status = "done";
      else if (e.reason === "wait_human") s.status = "waiting_human";
      else s.status = "stopped";
      break;
    case "hook_run":
    case "commit":
      break;
  }
  return s;
}

export function rebuildState(events: LedgerEvent[]): State {
  return events.reduce(reduce, initialState());
}

/** state.json을 통째로 바꿔 쓴다. 임시 파일에 쓰고 이름을 바꿔서, 쓰다 끊겨도 반쪽 파일이 남지 않게 한다. */
export function writeState(root: string, state: State): void {
  mkdirSync(join(root, DIR), { recursive: true });
  const tmp = statePath(root) + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, statePath(root));
}

export interface LoadResult {
  state: State;
  /** state.json을 원장에서 다시 만들었는지 */
  rebuilt: boolean;
  warnings: string[];
}

/** 상태를 읽는다. state.json이 없거나, 형식이 다르거나, 원장보다 낡았으면 원장에서 다시 만들어 저장한다. */
export function loadState(root: string): LoadResult {
  const { events, warnings } = readEvents(root);
  const file = statePath(root);
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as State;
      if (saved.schema_version === STATE_SCHEMA_VERSION && saved.events === events.length) {
        return { state: saved, rebuilt: false, warnings };
      }
    } catch {
      // 깨진 state.json은 원장에서 다시 만든다.
    }
  }
  const state = rebuildState(events);
  if (events.length > 0) writeState(root, state);
  return { state, rebuilt: true, warnings };
}
