// 잠금 검사를 원장 기록과 함께 돌리는 곳: git pre-commit과 차례 뒤 변경 검사

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { changedFiles, stagedFiles } from "./git.ts";
import { appendEvent, DIR, nextId, readEvents } from "./ledger.ts";
import { commitViolations, diffViolations, revertPaths } from "./lock.ts";
import { getNode, loadNodes, nodeFor, type NodeSet } from "./nodes.ts";
import { loadState } from "./state.ts";

export interface GuardResult {
  exitCode: 0 | 2;
  message: string;
  violations: string[];
}

/** git pre-commit: 올린 파일이 잠금을 어기면 막는다. */
export function checkCommit(root: string, env: NodeJS.ProcessEnv, nodes: NodeSet = loadNodes()): GuardResult {
  const config = loadConfig(root);
  const node = env.FOURDD_NODE ? nodeFor(nodes, env.FOURDD_NODE, env.FOURDD_FEATURE) : undefined;
  const waitingHuman = existsSync(join(root, DIR)) && loadState(root).state.status === "waiting_human";
  const found = commitViolations(config, { node, waitingHuman, allowLocked: env.FOURDD_ALLOW_LOCKED === "1" }, stagedFiles(root));
  if (found.length === 0) return { exitCode: 0, message: "", violations: [] };
  const { events } = readEvents(root);
  appendEvent(root, nodes.version, {
    type: "hook_run",
    id: nextId(events, "HR"),
    hook: "git.pre_commit",
    check: "commit",
    run: env.FOURDD_NODE_RUN ?? null,
    target: found.map((f) => f.path).join(", ").slice(0, 300),
    result: "blocked",
  });
  const lines = found.map((f) => `[4DD] ${f.path}: ${f.reason}`);
  return { exitCode: 2, message: `${lines.join("\n")}\n커밋을 막았습니다`, violations: found.map((f) => f.path) };
}

/** 차례 뒤 변경 검사: 이 노드에서 고칠 수 없는 곳이 바뀌었으면 기록하고, revert면 되돌린다. */
export function checkDiff(root: string, nodeId: string, runId: string | null, revert: boolean, nodes: NodeSet = loadNodes(), feature: string | null = null): GuardResult {
  const node = nodeFor(nodes, nodeId, feature);
  const bad = diffViolations(changedFiles(root), node);
  if (bad.length === 0) return { exitCode: 0, message: "", violations: [] };
  for (const path of bad) {
    const { events } = readEvents(root);
    appendEvent(root, nodes.version, { type: "hook_run", id: nextId(events, "HR"), hook: "harness.diff", check: "diff_lock", run: runId, target: path, result: "blocked" });
  }
  if (revert) revertPaths(root, bad);
  const verb = revert ? "되돌렸습니다" : "찾았습니다";
  return {
    exitCode: 2,
    message: `[4DD] ${nodeId}에서 고칠 수 없는 곳의 변경을 ${verb}: ${bad.join(", ")}`,
    violations: bad,
  };
}
