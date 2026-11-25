// git 부르기. 하네스가 만드는 커밋은 하네스 이름으로 남긴다.

import { execFileSync } from "node:child_process";

export const HARNESS_AUTHOR = { name: "4dd harness", email: "4dd-harness@localhost" };

export function git(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: HARNESS_AUTHOR.name,
      GIT_AUTHOR_EMAIL: HARNESS_AUTHOR.email,
      GIT_COMMITTER_NAME: HARNESS_AUTHOR.name,
      GIT_COMMITTER_EMAIL: HARNESS_AUTHOR.email,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 마지막 커밋 뒤로 바뀌었거나 새로 생긴 파일 (프로젝트 기준 상대 경로). 무시 목록(.gitignore)에 든 파일은 빼고, 이름을 바꾼 파일은 두 이름 모두 넣는다. */
export function changedFiles(root: string): string[] {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // 이름 바꿈과 복사는 다음 칸에 원래 이름이 온다.
    if (status.includes("R") || status.includes("C")) files.push(parts[++i]);
  }
  return [...new Set(files)].sort();
}

/** 커밋하려고 올려 둔(staged) 파일 */
export function stagedFiles(root: string): string[] {
  return git(root, ["diff", "--cached", "--name-only", "-z", "--no-renames"]).split("\0").filter(Boolean).sort();
}

/** 프로젝트가 아는 파일 전부 (추적 중인 파일과 무시되지 않은 새 파일) */
export function projectFiles(root: string): string[] {
  return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort();
}

export function isTracked(root: string, path: string): boolean {
  try {
    git(root, ["ls-files", "--error-unmatch", "--", path]);
    return true;
  } catch {
    return false;
  }
}
