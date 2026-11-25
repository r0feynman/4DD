// 쓰기 잠금 (하네스 설계 ⑤ 「쓰기 잠금」, 첫 구현 조각 명세 「잠금을 지키는 겹」)
//
// 규칙은 여기 한 곳에만 둔다. Claude 훅, Codex 훅, git 훅, 지휘 프로그램은 모두 이 함수들을 부른다.
//   - 세션(작업 세션, 리뷰 세션)은 그 노드의 writes에 맞는 경로만 고칠 수 있다.
//   - 잠긴 경로(locked)는 모든 노드에 걸리고, 노드의 writes에 적힌 경로만 그 노드에서 풀린다.
//   - .4dd/는 하네스만 쓴다.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { git, isTracked, projectFiles } from "./git.ts";
import { matchesAny } from "./glob.ts";
import { DIR, EventSchema } from "./ledger.ts";
import type { NodeDef } from "./nodes.ts";

/** 하네스만 쓰고, 하네스가 노드마다 함께 커밋하는 파일 */
export const HARNESS_FILES = [".4dd/events.jsonl", ".4dd/baseline.json", ".4dd/learnings.yaml", ".4dd/human/**"];
export const HARNESS_DIR = `${DIR}/**`;

export interface Decision {
  allowed: boolean;
  reason: string;
}

/** 파일 경로를 프로젝트 기준 상대 경로(슬래시)로 바꾼다. 프로젝트 밖이면 null. */
export function toProjectPath(root: string, file: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(resolve(root), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function writesText(node: NodeDef): string {
  return node.writes.length ? node.writes.map((w) => `\`${w}\``).join(", ") : "없음";
}

/** 세션이 이 노드에서 이 파일을 고쳐도 되나 */
export function canSessionWrite(root: string, node: NodeDef, file: string): Decision {
  const rel = toProjectPath(root, file);
  if (rel === null) return { allowed: false, reason: `${node.id}: 프로젝트 밖의 파일은 고칠 수 없습니다 (${file})` };
  if (matchesAny(rel, [HARNESS_DIR])) return { allowed: false, reason: `${node.id}: ${DIR}/는 하네스만 씁니다 (${rel})` };
  if (node.actor === "harness") return { allowed: true, reason: "" };
  if (matchesAny(rel, node.writes)) return { allowed: true, reason: "" };
  return { allowed: false, reason: `${node.id} ${node.name}: 이 노드에서 고칠 수 있는 곳은 ${writesText(node)}입니다 (${rel})` };
}

export interface CommitContext {
  /** 하네스가 이 노드를 통과시키고 커밋하는 중이면 그 노드 */
  node?: NodeDef;
  /** 사람 승인을 기다리는 중이면 사람이 기준(스펙, 설계)을 고칠 수 있다 */
  waitingHuman: boolean;
  /** 사람이 일부러 잠금을 풀었을 때 (FOURDD_ALLOW_LOCKED=1) */
  allowLocked: boolean;
}

/** 커밋에 올린 파일 가운데 막아야 할 것 */
export function commitViolations(config: Config, ctx: CommitContext, files: string[]): { path: string; reason: string }[] {
  const out: { path: string; reason: string }[] = [];
  for (const f of files) {
    if (ctx.node) {
      if (!matchesAny(f, [...ctx.node.writes, ...HARNESS_FILES])) {
        out.push({ path: f, reason: `하네스가 ${ctx.node.id}에서 커밋할 수 있는 곳은 ${writesText(ctx.node)}와 원장입니다` });
      }
      continue;
    }
    if (matchesAny(f, config.locked) && !ctx.waitingHuman && !ctx.allowLocked) {
      out.push({
        path: f,
        reason: "잠긴 파일입니다. 스펙이나 설계는 사람 승인 흐름(사람을 기다릴 때 고친 뒤 4dd human approve)에서 바꿉니다. 일부러 바꾸려면 FOURDD_ALLOW_LOCKED=1을 붙여 커밋합니다",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 셸 명령

const BLOCKED_GIT = new Set(["commit", "push", "reset", "rebase", "checkout", "switch", "restore", "stash", "merge", "cherry-pick", "revert", "tag", "branch", "clean", "am", "apply", "update-ref", "filter-branch"]);

/** 셸 명령에서 막을 것을 찾는다. 커밋과 브랜치, 기록을 바꾸는 git 명령은 하네스만 한다. */
export function bashViolation(command: string): string | null {
  // 따옴표 안의 글은 명령이 아니므로 지우고 본다 ("git commit"을 출력하는 echo 등).
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  for (const raw of bare.split(/&&|\|\||[;&|\n]|\$\(|`/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // 앞의 환경 변수 지정
    while (words.length && ["sudo", "command", "exec", "env", "nohup", "time"].includes(words[0])) words.shift();
    if (words[0] !== "git" && !words[0]?.endsWith("/git")) continue;
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) {
      // -C <폴더>, -c <이름=값>처럼 값을 받는 옵션은 값까지 건너뛴다.
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(words[i])) i++;
      i++;
    }
    const sub = words[i];
    if (sub && BLOCKED_GIT.has(sub)) return `git ${sub}는 하네스만 합니다. 커밋과 브랜치는 하네스가 노드를 통과시킬 때 만듭니다`;
  }
  return null;
}

// ---------------------------------------------------------------- 기준 해시 (재사용 전 검증)

export const BASELINE_FILE = `${DIR}/baseline.json`;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 잠긴 경로에 맞는 프로젝트 파일 (하네스 폴더 .4dd/는 빼고) */
export function lockedFiles(root: string, config: Config): string[] {
  return projectFiles(root).filter((f) => matchesAny(f, config.locked) && !matchesAny(f, [HARNESS_DIR]) && existsSync(join(root, f)) && statSync(join(root, f)).isFile());
}

export function computeBaseline(root: string, config: Config): Record<string, string> {
  return Object.fromEntries(lockedFiles(root, config).map((f) => [f, sha256(join(root, f))]));
}

export function writeBaseline(root: string, baseline: Record<string, string>): void {
  writeFileSync(join(root, BASELINE_FILE), JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

export function readBaseline(root: string): Record<string, string> {
  const file = join(root, BASELINE_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
}

/** 잠긴 파일이 기준 해시와 다른 곳. 비어 있으면 기준이 그대로다. */
export function baselineDiff(root: string, config: Config): { changed: string[]; added: string[]; removed: string[] } {
  const saved = readBaseline(root);
  const now = computeBaseline(root, config);
  return {
    changed: Object.keys(now).filter((f) => f in saved && saved[f] !== now[f]),
    added: Object.keys(now).filter((f) => !(f in saved)),
    removed: Object.keys(saved).filter((f) => !(f in now)),
  };
}

// ---------------------------------------------------------------- 차례 뒤 변경 검사

/** 세션 동안 바뀌어도 되는 하네스 파일. 원장은 훅이 덧붙이고(덧붙기만 했는지는 ledgerIntact로 따로 본다), state.json은 원장에서 다시 만든다. */
export const SESSION_HARNESS_FILES = [".4dd/events.jsonl", ".4dd/state.json", ".4dd/*.tmp"];

/** 세션 한 차례 동안 바뀐 파일 가운데 이 노드에서 고칠 수 없는 것. .4dd/의 다른 파일(훅 설정, 기준 해시)을 고쳤으면 잡는다. */
export function diffViolations(changed: string[], node: NodeDef): string[] {
  return changed.filter((f) => !matchesAny(f, SESSION_HARNESS_FILES) && !matchesAny(f, node.writes));
}

/** 고칠 수 없는 곳의 변경을 마지막 커밋 상태로 되돌린다. 새로 생긴 파일은 지운다. */
export function revertPaths(root: string, paths: string[]): void {
  const tracked = paths.filter((p) => isTracked(root, p));
  const untracked = paths.filter((p) => !tracked.includes(p));
  if (tracked.length) git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  for (const p of untracked) rmSync(join(root, p), { force: true, recursive: true });
}

// ---------------------------------------------------------------- 원장 지키기

export interface LedgerSnapshot {
  size: number;
  hash: string;
}

function ledgerBytes(root: string): Buffer {
  const file = join(root, DIR, "events.jsonl");
  return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
}

/** 세션을 돌리기 전 원장의 크기와 해시 */
export function ledgerSnapshot(root: string): LedgerSnapshot {
  const b = ledgerBytes(root);
  return { size: b.length, hash: createHash("sha256").update(b).digest("hex") };
}

/** 세션 동안 원장이 덧붙기만 했고, 덧붙은 줄이 훅 실행 기록뿐인지 본다. 에이전트가 원장을 고쳤으면 실패. */
export function ledgerIntact(root: string, before: LedgerSnapshot): Decision {
  const b = ledgerBytes(root);
  if (b.length < before.size) return { allowed: false, reason: "세션 동안 원장이 줄었습니다" };
  const head = createHash("sha256").update(b.subarray(0, before.size)).digest("hex");
  if (head !== before.hash) return { allowed: false, reason: "세션 동안 원장의 앞부분이 바뀌었습니다" };
  const added = b.subarray(before.size).toString("utf8").split("\n").filter((l) => l.trim());
  for (const line of added) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { allowed: false, reason: "세션 동안 원장에 JSON이 아닌 줄이 붙었습니다" };
    }
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== "hook_run") {
      return { allowed: false, reason: "세션 동안 원장에 훅 실행 기록이 아닌 줄이 붙었습니다" };
    }
  }
  return { allowed: true, reason: "" };
}
