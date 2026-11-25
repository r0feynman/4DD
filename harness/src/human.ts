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
import { CAUSES, loadNodes, type Cause } from "./nodes.ts";
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

export function humanAction(root: string, kind: HumanKind, arg?: string, minutes?: number): string {
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
  const extra = { ...(minutes !== undefined ? { minutes } : {}), ...(!task && state.planning ? { feature: state.planning } : {}) };

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
      appendEvent(root, H, { type: "human", id, node, task, kind: "approve", ...(reason ? { reason } : {}), ...(textHash ? { text_hash: textHash } : {}), ...extra });
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "--allow-empty", "-m", `human approve (${reason ?? state.status})\n\n4DD-Node: ${node}\n${task ? `4DD-Task: ${task}\n` : ""}4DD-Human: ${id}`], { FOURDD_ALLOW_LOCKED: "1" });
      const sha = git(root, ["rev-parse", "HEAD"]).trim();
      appendEvent(root, H, { type: "commit", sha, node, task });
      loadState(root);
      return `${id} 승인했습니다. 잠긴 파일의 기준 해시를 새로 고정하고 커밋했습니다 (${sha.slice(0, 7)}). 4dd run으로 이어 갑니다`;
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
