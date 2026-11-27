// PO 창구가 부르는 사람 명령 (조각 2 명세 「PO 창구」, 「승인과 되돌림」, 「승인을 지키는 겹」)
//
//   4dd story   N01: PO의 말을 그대로 story.md로 남기고 그 기능의 Stage 0을 시작한다
//   4dd review  기다리는 승인(N04, N15)의 검토 페이지를 만들고 무엇을 보여 줬는지 해시로 남긴다
//   4dd human approve|reject --review RV…  PO의 답을 그대로 남긴다. 승인은 검토 해시가 지금 파일과 같을 때만
//
// 하네스가 띄운 작업 세션(FOURDD_NODE가 있음)에서는 아무것도 하지 않는다. 승인을 에이전트가 남길 수 없게 하기 위해서다.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { HUMAN_DIR } from "./context.ts";
import { git } from "./git.ts";
import { addLearningCandidate } from "./human.ts";
import { appendEvent, DIR, FEATURE_NAME, nextId, readEvents, type LedgerEvent } from "./ledger.ts";
import { computeBaseline, writeBaseline } from "./lock.ts";
import { allowedCauses, getNode, loadNodes, type Cause, type NodeSet } from "./nodes.ts";
import { combinedHash, featureIds, featureOfTask, featurePath, hashFiles, openQuestions, readText, reviewFilesFor, sha256, type StoryType } from "./plan.ts";
import { featureTitle, renderReviewPage } from "./review.ts";
import { loadState, type State } from "./state.ts";
import { parseTasks } from "./trace.ts";

export const REVIEW_DIR = `${DIR}/review`;

export class PoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoError";
  }
}

export interface Speaker {
  /** po: PO의 말을 창구가 옮김 · dev: 개발자가 직접 · script: 각본 PO */
  by?: "po" | "dev" | "script";
  channel?: "chat" | "terminal";
  /** 기능의 작업 유형 (조각 3, 4dd story --type). 프로젝트가 「기능 단위」일 때 씀 */
  type?: StoryType;
}

/** 하네스가 띄운 세션에서는 사람 명령을 쓰지 않는다 (승인을 지키는 겹: 사람 명령의 세션 검사) */
function refuseInSession(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FOURDD_NODE) throw new PoError(`하네스가 띄운 세션(${env.FOURDD_NODE})에서는 사람 명령을 쓸 수 없습니다. 승인과 되돌림은 PO 창구만 남깁니다`);
}

function saveText(root: string, id: string, text: string): string {
  mkdirSync(join(root, HUMAN_DIR), { recursive: true });
  writeFileSync(join(root, HUMAN_DIR, `${id}.md`), text.trim() + "\n");
  return sha256(text.trim()).slice(0, 12);
}

function commit(root: string, node: string, feature: string, subject: string, trailers: string[]): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", [subject, "", `4DD-Node: ${node}`, ...trailers].join("\n")], { FOURDD_NODE: node, FOURDD_FEATURE: feature });
  return git(root, ["rev-parse", "HEAD"]).trim();
}

/** 지금 기다리는 승인의 노드와 기능 */
function waitingReview(root: string, nodes: NodeSet, state: State): { node: string; feature: string; task: string | null } {
  if (state.status !== "waiting_human" || state.waiting?.reason !== "review") {
    throw new PoError(`검토 승인을 기다리는 중이 아닙니다 (상태: ${state.status}${state.waiting ? `, ${state.waiting.node}에서 ${state.waiting.reason}` : ""})`);
  }
  const node = state.waiting.node;
  if (!getNode(nodes, node).approve) throw new PoError(`${node}는 사람 승인 노드가 아닙니다`);
  const task = state.waiting.task ?? state.task;
  const feature = state.planning ?? (task ? featureOfTask(root, task) : null) ?? state.feature;
  if (!feature) throw new PoError("어느 기능의 승인인지 모릅니다");
  return { node, feature, task };
}

// ---------------------------------------------------------------- 4dd story (N01)

export function tellStory(root: string, feature: string, text: string, who: Speaker = {}, env: NodeJS.ProcessEnv = process.env): string {
  refuseInSession(env);
  const nodes = loadNodes();
  const H = nodes.version;
  if (!FEATURE_NAME.test(feature)) throw new PoError(`기능 이름은 영문 소문자, 숫자, -만 씁니다 (예: password-reset): ${feature}`);
  if (!text.trim()) throw new PoError("스토리 글이 필요합니다");
  const { state } = loadState(root);
  const retell = state.status === "waiting_human" && state.waiting?.node === "N01" && state.planning === feature;
  if (!retell) {
    if (state.planning) throw new PoError(`이미 Stage 0·1을 도는 기능이 있습니다: ${state.planning}. 끝나거나 보류한 뒤에 새 스토리를 받습니다`);
    if (state.task) throw new PoError(`개발 중인 작업이 있습니다: ${state.task}. 작업이 끝난 뒤에 새 스토리를 받습니다`);
    if (state.status === "waiting_human" || state.status === "stopped") throw new PoError(`사람을 기다리는 중입니다 (${state.waiting?.node ?? state.node}). 그 일부터 정리합니다`);
    if (readText(root, featurePath(feature, "spec.md")) !== null) throw new PoError(`이미 있는 기능입니다: specs/${feature}/. 새 기능 이름을 정합니다`);
  }
  const { events } = readEvents(root);
  const id = nextId(events, "HU");
  const runId = nextId(events, "NR");
  // 작업 유형: 프로젝트가 「기능 단위」면 기능마다 정해 story.md 머리에 남긴다(없으면 backend). 아니면 프로젝트 유형과 같아야 함
  const projectType = loadConfig(root).work_type;
  if (who.type && projectType !== "feature" && who.type !== projectType) throw new PoError(`이 프로젝트의 작업 유형은 ${projectType}입니다. 기능마다 유형을 정하려면 4dd.config.yaml의 work_type이 feature여야 합니다`);
  const typeLine = projectType === "feature" ? `작업 유형: ${who.type ?? "backend"}\n\n` : "";
  mkdirSync(join(root, "specs", feature), { recursive: true });
  writeFileSync(join(root, featurePath(feature, "story.md")), `# 스토리: ${feature} (${id})\n\n${typeLine}${text.trim()}\n`);
  const hash = saveText(root, id, text);
  appendEvent(root, H, { type: "node_start", id: runId, node: "N01", task: null, feature, session: null });
  appendEvent(root, H, { type: "node_end", id: runId, node: "N01", task: null, feature, result: "pass", minutes: 0 });
  appendEvent(root, H, { type: "human", id, node: "N01", task: null, kind: "story", feature, text_hash: hash, by: who.by ?? "po", channel: who.channel ?? "chat" });
  // story.md는 잠긴 경로(specs/**)라, 기준 해시를 새로 적고 함께 커밋한다
  writeBaseline(root, computeBaseline(root, loadConfig(root)));
  const sha = commit(root, "N01", feature, `N01: 스토리 (${feature})`, [`4DD-Human: ${id}`]);
  appendEvent(root, H, { type: "commit", sha, node: "N01", task: null });
  loadState(root);
  return `${id} 스토리를 받았습니다: specs/${feature}/story.md. 4dd run으로 스펙(N02)부터 진행합니다`;
}

// ---------------------------------------------------------------- 4dd review

export interface ReviewBuilt {
  id: string;
  node: string;
  feature: string;
  file: string;
  title: string;
  hash: string;
}

export function buildReview(root: string, env: NodeJS.ProcessEnv = process.env): ReviewBuilt {
  refuseInSession(env);
  const nodes = loadNodes();
  const { state } = loadState(root);
  const w = waitingReview(root, nodes, state);
  const node = getNode(nodes, w.node);
  const { events } = readEvents(root);
  const id = nextId(events, "RV");
  const files = hashFiles(root, reviewFilesFor(root, w.feature, node.review ?? []));
  const hash = combinedHash(files);
  const html = renderReviewPage({ root, node, feature: w.feature, id, hash, files, events });
  mkdirSync(join(root, REVIEW_DIR), { recursive: true });
  const file = `${REVIEW_DIR}/${id}.html`;
  writeFileSync(join(root, file), html, "utf8");
  appendEvent(root, nodes.version, { type: "review", id, action: "built", node: w.node, task: w.task, feature: w.feature, files, hash });
  return { id, node: w.node, feature: w.feature, file, title: `${featureTitle(root, w.feature)} 검토`, hash };
}

type ReviewEvent = Extract<LedgerEvent, { type: "review" }>;

function lastBuilt(events: LedgerEvent[], node?: string): ReviewEvent | undefined {
  return events.filter((e): e is ReviewEvent => e.type === "review" && e.action === "built" && (!node || e.node === node)).at(-1);
}

/** 검토 페이지를 아티팩트로 게시한 주소를 남긴다 (사람 대기 시간을 재는 시작점) */
export function recordPublished(root: string, url: string, reviewId?: string, env: NodeJS.ProcessEnv = process.env): string {
  refuseInSession(env);
  const nodes = loadNodes();
  const { events } = readEvents(root);
  const built = reviewId ? events.find((e): e is ReviewEvent => e.type === "review" && e.action === "built" && e.id === reviewId) : lastBuilt(events);
  if (!built) throw new PoError(reviewId ? `검토 페이지 ${reviewId}가 없습니다` : "만든 검토 페이지가 없습니다. 4dd review로 먼저 만듭니다");
  appendEvent(root, nodes.version, { type: "review", id: built.id, action: "published", node: built.node, task: built.task, feature: built.feature, files: built.files, hash: built.hash, url });
  return `${built.id} 게시 주소를 남겼습니다: ${url}`;
}

// ---------------------------------------------------------------- 4dd human approve|reject --review

function checkReview(root: string, nodes: NodeSet, reviewId: string): { review: ReviewEvent; node: string; feature: string; task: string | null } {
  const { state } = loadState(root);
  const w = waitingReview(root, nodes, state);
  const { events } = readEvents(root);
  const review = events.find((e): e is ReviewEvent => e.type === "review" && e.action === "built" && e.id === reviewId);
  if (!review) throw new PoError(`검토 페이지 ${reviewId}가 없습니다`);
  if (review.node !== w.node) throw new PoError(`${reviewId}는 ${review.node}의 검토 페이지입니다. 지금 기다리는 승인은 ${w.node}입니다`);
  const latest = lastBuilt(events, w.node);
  if (latest && latest.id !== reviewId) throw new PoError(`${reviewId}보다 새 검토 페이지 ${latest.id}가 있습니다. PO가 본 최신 페이지로 답합니다`);
  return { review, node: w.node, feature: w.feature, task: w.task };
}

export function approveReview(root: string, reviewId: string, quote: string, who: Speaker = {}, env: NodeJS.ProcessEnv = process.env): string {
  refuseInSession(env);
  if (!quote.trim()) throw new PoError("PO의 말을 그대로 남겨야 합니다 (--quote \"…\")");
  const nodes = loadNodes();
  const H = nodes.version;
  const { review, node, feature, task } = checkReview(root, nodes, reviewId);
  const def = getNode(nodes, node);
  // 검토 해시: PO가 본 것과 승인되는 것이 같아야 한다
  const now = combinedHash(hashFiles(root, review.files.map((f) => f.path)));
  if (now !== review.hash) {
    const changed = review.files.filter((f) => hashFiles(root, [f.path])[0].hash !== f.hash).map((f) => f.path);
    throw new PoError(`검토 페이지를 보낸 뒤 파일이 바뀌었습니다: ${changed.join(", ")}. 4dd review로 새 페이지를 만들어 다시 받습니다`);
  }
  if (def.approve?.requires.includes("no_open_questions")) {
    const q = openQuestions(readText(root, featurePath(feature, "spec.md")) ?? "");
    if (q.length) throw new PoError(`스펙에 답하지 않은 물을 것이 ${q.length}개 있어 승인할 수 없습니다. PO의 답을 4dd human reject --cause spec_ambiguous로 넘겨 스펙을 고칩니다`);
  }
  const { events } = readEvents(root);
  const id = nextId(events, "HU");
  const hash = saveText(root, id, quote);
  appendEvent(root, H, { type: "human", id, node, task, kind: "approve", feature, review: reviewId, by: who.by ?? "po", channel: who.channel ?? "chat", text_hash: hash });
  const ids = featureIds(root, feature);
  const tasks = def.approve!.packet === "1-2" ? parseTasks(readText(root, featurePath(feature, "tasks.md")) ?? "", "tasks.md").tasks.map((t) => t.id) : [];
  const pk = nextId(readEvents(root).events, "PK");
  appendEvent(root, H, { type: "packet", id: pk, boundary: def.approve!.packet, feature, files: review.files, refs: [...ids.R, ...ids.S, ...tasks], review: reviewId });
  writeBaseline(root, computeBaseline(root, loadConfig(root)));
  const sha = commit(root, node, feature, `${node}: 승인 (${feature}, ${reviewId})`, [...(task ? [`4DD-Task: ${task}`] : []), `4DD-Human: ${id}`, `4DD-Review: ${reviewId}`, `4DD-Packet: ${pk}`]);
  appendEvent(root, H, { type: "commit", sha, node, task });
  loadState(root);
  return `${id} 승인을 남겼습니다 (${reviewId}, 패킷 ${def.approve!.packet} ${pk}). 4dd run으로 이어 갑니다`;
}

export interface RejectOptions extends Speaker {
  cause?: Cause;
  to?: string;
}

export function rejectReview(root: string, reviewId: string, quote: string, opts: RejectOptions = {}, env: NodeJS.ProcessEnv = process.env): string {
  refuseInSession(env);
  if (!quote.trim()) throw new PoError("PO의 말을 그대로 남겨야 합니다 (--quote \"…\")");
  const nodes = loadNodes();
  const H = nodes.version;
  const { node, feature, task } = checkReview(root, nodes, reviewId);
  const def = getNode(nodes, node);
  if (def.kind === "decision") {
    const causes = allowedCauses(nodes, node);
    if (!opts.cause || !causes.includes(opts.cause)) throw new PoError(`${node}에서 되돌릴 때는 원인을 고릅니다: ${causes.join(", ")} (--cause)`);
  } else if (!opts.to || !(def.on_reject ?? []).includes(opts.to)) {
    throw new PoError(`${node}에서 되돌릴 때는 고칠 노드를 고릅니다: ${(def.on_reject ?? []).join(", ")} (--to)`);
  }
  const { events } = readEvents(root);
  const id = nextId(events, "HU");
  const hash = saveText(root, id, quote);
  appendEvent(root, H, {
    type: "human",
    id,
    node,
    task,
    kind: "reject",
    feature,
    review: reviewId,
    by: opts.by ?? "po",
    channel: opts.channel ?? "chat",
    text_hash: hash,
    ...(opts.cause ? { cause: opts.cause } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  });
  // PO의 말도 학습 후보 (조각 2 정한 것): 같은 종류의 되돌림이 반복되면 지시문 「주의점」 후보가 된다
  const lid = opts.by === "script" ? null : addLearningCandidate(root, H, quote, [reviewId, id], node);
  const sha = commit(root, node, feature, `${node}: 되돌림 (${feature}, ${reviewId})`, [...(task ? [`4DD-Task: ${task}`] : []), `4DD-Human: ${id}`, `4DD-Review: ${reviewId}`]);
  appendEvent(root, H, { type: "commit", sha, node, task });
  loadState(root);
  const where = opts.cause ? `${opts.cause}로 스펙부터` : `${opts.to}부터`;
  return `${id} 되돌림을 남겼습니다 (${where}). PO의 말이 다음 차례의 힌트가 됩니다${lid ? `. 학습 후보 ${lid}로 더했습니다` : ""}. 4dd run으로 이어 갑니다`;
}
