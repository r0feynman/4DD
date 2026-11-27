// 4dd human: 사람 개입을 원장에 남기고 다시 시작할 수 있게 한다 (하네스 설계 ⑦ 「사람 개입 기록」).
//
//   approve     스펙·설계를 고쳤거나 그대로 진행해도 된다. 잠긴 파일의 기준 해시를 새로 고정하고 바뀐 것을 커밋한다.
//   hint <글>   힌트를 주고 다시 시도한다. 힌트는 다음 차례의 맥락에 들어가고, 바로 학습 후보가 된다(설계 ⑥).
//   reclassify <원인>  실패 원인을 바로잡는다.
//   hold        이 작업을 보류하고 다음 작업으로 간다.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadConfig } from "./config.ts";
import { HUMAN_DIR } from "./context.ts";
import { git } from "./git.ts";
import { appendEvent, DIR, nextId, readEvents } from "./ledger.ts";
import { computeBaseline, writeBaseline } from "./lock.ts";
import { CAUSES, getNode, loadNodes, type Cause } from "./nodes.ts";
import { loadState } from "./state.ts";

export type HumanKind = "approve" | "hint" | "reclassify" | "hold";
export const LEARNINGS_FILE = `${DIR}/learnings.yaml`;

export class HumanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanError";
  }
}

/** 힌트를 학습 후보로 더한다 (설계 ⑥: 횟수 초과 때 사람이 준 힌트는 바로 후보로). */
export function addLearningCandidate(root: string, harness: string, text: string, evidence: string[], node: string): string {
  const file = join(root, LEARNINGS_FILE);
  const list = existsSync(file) ? ((parse(readFileSync(file, "utf8")) as Record<string, unknown>[] | null) ?? []) : [];
  const id = `L${list.length + 1}`;
  list.push({
    id,
    scope: "project",
    kind: "instruction",
    change: `${node} 지시문: ${text.split("\n")[0].slice(0, 200)}`,
    evidence,
    metric: "first_pass_rate",
    status: "candidate",
    harness,
    verified_at: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(file, stringify(list));
  return id;
}

export interface HumanOptions {
  /**
   * approve: 이 작업 노드의 일을 사람이 확인했으니 같은 노드를 다시 하지 않고 이 노드부터 이어 간다 (2026-11-27 실제 실행).
   * 하네스 경로가 맞지 않아 같은 노드가 헛도는 때에 쓴다. 같은 스테이지의 노드만 받는다.
   */
  to?: string;
  /** 누가 개입했나 (po · dev · script) */
  by?: "po" | "dev" | "script";
  channel?: "chat" | "terminal";
}

export function humanAction(root: string, kind: HumanKind, arg?: string, minutes?: number, opts: HumanOptions = {}): string {
  const nodes = loadNodes();
  const H = nodes.version;
  const { state } = loadState(root);
  const ok = state.status === "waiting_human" || (kind === "approve" && state.status === "stopped");
  if (!ok) throw new HumanError(`사람을 기다리는 중이 아닙니다 (상태: ${state.status})`);
  const node = state.waiting?.node ?? state.node ?? "N21";
  const task = state.waiting?.task ?? state.task;
  const reason = (CAUSES as readonly string[]).includes(state.waiting?.reason ?? "") ? (state.waiting?.reason as Cause) : undefined;
  const { events } = readEvents(root);
  const id = nextId(events, "HU");
  // 작업 없이 Stage 0·1을 도는 기능이면 기능으로 묶는다 (조각 2: 다음 차례의 맥락이 그 기능의 사람 말을 찾음)
  const extra = {
    ...(minutes !== undefined ? { minutes } : {}),
    ...(!task && state.planning ? { feature: state.planning } : {}),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
  if (opts.to !== undefined) {
    if (kind !== "approve") throw new HumanError("--to는 approve에만 씁니다");
    const target = nodes.nodes[opts.to];
    if (!target) throw new HumanError(`모르는 노드입니다: ${opts.to}`);
    if (target.stage !== getNode(nodes, node).stage) throw new HumanError(`--to는 같은 스테이지의 노드만 받습니다 (${node}는 Stage ${getNode(nodes, node).stage}, ${opts.to}는 Stage ${target.stage})`);
  }

  switch (kind) {
    case "approve": {
      writeBaseline(root, computeBaseline(root, loadConfig(root)));
      // 승인하며 준 답(예: 스펙으로 돌아갈 때 PO의 답)은 다음 차례의 맥락에 들어간다
      let textHash: string | undefined;
      if (arg?.trim()) {
        mkdirSync(join(root, HUMAN_DIR), { recursive: true });
        writeFileSync(join(root, HUMAN_DIR, `${id}.md`), arg.trim() + "\n");
        textHash = createHash("sha256").update(arg.trim()).digest("hex").slice(0, 12);
      }
      appendEvent(root, H, { type: "human", id, node, task, kind: "approve", ...(reason ? { reason } : {}), ...(textHash ? { text_hash: textHash } : {}), ...(opts.to ? { to: opts.to } : {}), ...extra });
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "--allow-empty", "-m", `human approve (${reason ?? state.status})\n\n4DD-Node: ${node}\n${task ? `4DD-Task: ${task}\n` : ""}4DD-Human: ${id}`], { FOURDD_ALLOW_LOCKED: "1" });
      const sha = git(root, ["rev-parse", "HEAD"]).trim();
      appendEvent(root, H, { type: "commit", sha, node, task });
      loadState(root);
      return `${id} 승인했습니다. 잠긴 파일의 기준 해시를 새로 고정하고 커밋했습니다 (${sha.slice(0, 7)}). 4dd run으로 ${opts.to ? `${opts.to}부터 ` : ""}이어 갑니다`;
    }
    case "hint": {
      if (!arg?.trim()) throw new HumanError("힌트 글이 필요합니다: 4dd human hint \"<힌트>\"");
      mkdirSync(join(root, HUMAN_DIR), { recursive: true });
      writeFileSync(join(root, HUMAN_DIR, `${id}.md`), arg.trim() + "\n");
      const hash = createHash("sha256").update(arg.trim()).digest("hex").slice(0, 12);
      appendEvent(root, H, { type: "human", id, node, task, kind: "hint", ...(reason ? { reason } : {}), text_hash: hash, ...extra });
      const lastEnd = events.filter((e) => e.type === "node_end").at(-1);
      const lastGate = events.filter((e) => e.type === "gate_run").at(-1);
      const evidence = [lastEnd?.type === "node_end" ? lastEnd.id : null, lastGate?.type === "gate_run" ? lastGate.id : null, id].filter((x): x is string => !!x);
      const lid = addLearningCandidate(root, H, arg, evidence, node);
      // 힌트 글과 학습 후보만 커밋한다. 커밋하지 않으면 다음 노드의 차례 뒤 변경 검사가
      // 그 노드가 잠긴 파일을 고친 것으로 보고 되돌린다 (2026-11-26 실제 실행에서 힌트와 학습 후보가 지워짐).
      // 실패한 노드가 남긴 작업 중 변경은 커밋하지 않는다: 힌트를 받고 그 노드가 이어서 고친다.
      const mine = [`${HUMAN_DIR}/${id}.md`, LEARNINGS_FILE];
      git(root, ["add", "--", ...mine]);
      git(root, ["commit", "-q", "-m", `human hint\n\n4DD-Node: ${node}\n${task ? `4DD-Task: ${task}\n` : ""}4DD-Human: ${id}`, "--", ...mine], { FOURDD_ALLOW_LOCKED: "1" });
      appendEvent(root, H, { type: "commit", sha: git(root, ["rev-parse", "HEAD"]).trim(), node, task });
      loadState(root);
      return `${id} 힌트를 남겼습니다. 다음 차례의 맥락에 들어가고, 학습 후보 ${lid}로 더했습니다. 4dd run으로 이어 갑니다`;
    }
    case "reclassify": {
      if (!arg || !(CAUSES as readonly string[]).includes(arg)) throw new HumanError(`실패 원인은 ${CAUSES.join(", ")} 가운데 하나입니다`);
      appendEvent(root, H, { type: "human", id, node, task, kind: "reclassify", ...(reason ? { reason } : {}), cause: arg as Cause, ...extra });
      loadState(root);
      return `${id} 실패 원인을 ${arg}로 바로잡았습니다. 4dd run으로 이어 갑니다`;
    }
    case "hold": {
      appendEvent(root, H, { type: "human", id, node, task, kind: "hold", ...(reason ? { reason } : {}), ...extra });
      loadState(root);
      return `${id} ${task ?? "작업"}을 보류했습니다. 4dd run은 다음 작업으로 갑니다`;
    }
  }
}
