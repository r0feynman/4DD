// 테스트 수와 건너뛰기 표시를 소스에서 센다 (관문의 new_tests, test_count_kept, no_new_skips).
//
// 테스트 실행기의 출력 형식에 기대지 않으려고 소스를 읽어 센다. Vitest, Jest, Mocha가 쓰는
// it(…), test(…)와 건너뛰기 표시(.skip, .todo, .only, xit …)를 대상으로 한다.
// 지금 작업 폴더뿐 아니라 git의 한 시점(작업 시작 커밋 등)도 셀 수 있어서, 지휘 프로그램이 죽었다 살아나도 다시 셀 수 있다.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";

export const TEST_DIR = "tests";
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_CALL = /(?<![\w$.])(?:it|test)(?:\.(?:each\s*\([^)]*\)|concurrent|sequential|fails))?\s*\(/g;
const SKIP_MARK = /(?<![\w$])(?:(?:it|test|describe|suite)\.(?:skip|todo|only|skipIf|runIf)|xit|xtest|xdescribe|fit|fdescribe)\s*\(/g;

export interface TestCount {
  tests: number;
  skips: number;
  /** 파일별 테스트 수 (프로젝트 기준 상대 경로) */
  files: Record<string, number>;
}

/** 주석을 지운다. URL 안의 // 처럼 앞에 공백이 없는 것은 남긴다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function countSource(src: string): { tests: number; skips: number } {
  const code = stripComments(src);
  return { tests: (code.match(TEST_CALL) ?? []).length, skips: (code.match(SKIP_MARK) ?? []).length };
}

function tally(entries: [string, string][]): TestCount {
  const out: TestCount = { tests: 0, skips: 0, files: {} };
  for (const [path, src] of entries) {
    const c = countSource(src);
    out.tests += c.tests;
    out.skips += c.skips;
    out.files[path] = c.tests;
  }
  return out;
}

function walk(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const child = `${rel}/${name}`;
    if (name === "node_modules") return [];
    return statSync(join(root, child)).isDirectory() ? walk(root, child) : TEST_FILE.test(name) ? [child] : [];
  });
}

/** 지금 작업 폴더의 테스트 (dir 아래) */
export function countWorktree(root: string, dir: string = TEST_DIR): TestCount {
  return tally(walk(root, dir).sort().map((p) => [p, readFileSync(join(root, p), "utf8")]));
}

/** git 한 시점의 테스트 (dir 아래) */
export function countAtRef(root: string, ref: string, dir: string = TEST_DIR): TestCount {
  const listed = git(root, ["ls-tree", "-r", "--name-only", ref, "--", dir]).split("\n").filter((p) => p && TEST_FILE.test(p));
  return tally(listed.map((p) => [p, git(root, ["show", `${ref}:${p}`])]));
}
