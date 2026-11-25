// 4dd init: 시험 프로젝트를 새 git 저장소로 복사하고, 훅을 걸고, 잠긴 파일의 기준 해시를 고정한다.

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { git } from "./git.ts";
import { DIR } from "./ledger.ts";
import { computeBaseline, writeBaseline } from "./lock.ts";
import { checkProject, formatIssues } from "./trace.ts";

export const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));
export const DEFAULT_FIXTURE = fileURLToPath(new URL("../fixtures/login-backend", import.meta.url));
const SKIP = new Set(["node_modules", ".git", DIR]);

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 훅이 부를 명령. nvm처럼 PATH가 세션마다 다를 수 있어 node와 cli를 절대 경로로 적는다. */
export function hookCommand(args: string): string {
  return `${q(process.execPath)} ${q(CLI_PATH)} ${args}`;
}

function claudeHooksJson(): string {
  const command = hookCommand("check hook --tool claude");
  const entry = (m?: string) => [{ ...(m ? { matcher: m } : {}), hooks: [{ type: "command", command }] }];
  return JSON.stringify({ hooks: { PreToolUse: entry("Edit|Write|MultiEdit|NotebookEdit|Bash"), SessionStart: entry() } }, null, 2) + "\n";
}

export interface InitOptions {
  from?: string;
  install?: boolean;
}

export interface InitResult {
  root: string;
  commit: string;
  locked: number;
}

export function initProject(dest: string, opts: InitOptions = {}): InitResult {
  const root = resolve(dest);
  const from = resolve(opts.from ?? DEFAULT_FIXTURE);
  if (existsSync(root) && readdirSync(root).length > 0) throw new InitError(`폴더가 비어 있지 않습니다: ${root}`);
  if (!existsSync(join(from, "4dd.config.yaml"))) throw new InitError(`4dd.config.yaml이 없는 원본입니다: ${from}`);

  // 1. 원본 복사 (node_modules, .git, .4dd는 빼고)
  mkdirSync(root, { recursive: true });
  cpSync(from, root, { recursive: true, filter: (src) => !SKIP.has(basename(src)) || src === from });

  // 2. 설정과 추적 ID 검사. 둘 중 하나라도 틀리면 시작하지 않는다.
  const config = loadConfig(root);
  const traces = checkProject(root);
  if (traces.some((t) => t.issues.some((i) => i.level === "error"))) {
    throw new InitError(`추적 검사를 통과하지 못해 시작하지 않습니다:\n${formatIssues(traces)}`);
  }

  // 3. 훅: Claude는 지휘 프로그램이 --settings로 넘긴다. Codex는 신뢰하지 않은 프로젝트의 설정을 읽지 않으므로
  //    프로젝트가 아니라 사용자 설정에 한 번 넣는다 (4dd setup codex, setup.ts).
  mkdirSync(join(root, DIR, "hooks"), { recursive: true });
  writeFileSync(join(root, DIR, "hooks", "claude.json"), claudeHooksJson());
  mkdirSync(join(root, ".githooks"), { recursive: true });
  const preCommit = join(root, ".githooks", "pre-commit");
  writeFileSync(preCommit, `#!/bin/sh\n# 4DD 잠금 검사 (4dd init이 만듦)\nexec ${hookCommand("check commit")}\n`);
  chmodSync(preCommit, 0o755);
  // node_modules는 링크로 둘 수도 있어서(폴더가 아니면 "node_modules/"에 안 맞음) 슬래시 없이 한 번 더 적는다.
  appendFileSync(join(root, ".gitignore"), `\n# 4DD: 원장에서 다시 만드는 파일과 관문 출력\n${DIR}/state.json\n${DIR}/*.tmp\n${DIR}/gates/\n${DIR}/review/\n${DIR}/report.md\nnode_modules\n`);

  // 4. git 저장소. 기준 해시는 git이 아는 파일로 정하므로 저장소를 먼저 만든다.
  git(root, ["init", "-q", "-b", "main"]);
  writeBaseline(root, computeBaseline(root, config));
  const locked = Object.keys(computeBaseline(root, config)).length;

  // 5. 시험 프로젝트의 의존 패키지
  if (opts.install !== false && existsSync(join(root, "package-lock.json"))) {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdio: "ignore" });
  }

  // 6. 첫 커밋 뒤에 git 훅을 켠다 (첫 커밋은 잠긴 파일을 처음 올리는 것이라 막히면 안 된다).
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "4dd init\n\n4DD-Node: init"]);
  git(root, ["config", "core.hooksPath", ".githooks"]);
  const commit = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  return { root, commit, locked };
}

export const fixtureDir = (name: string) => join(dirname(DEFAULT_FIXTURE), name);
