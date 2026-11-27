// 경로 패턴 맞추기. nodes.yaml의 writes와 4dd.config.yaml의 locked에 쓴다.
//   *   한 폴더 안의 아무 글자 (/는 넘지 않음)
//   **  폴더 여럿을 넘는 아무 글자 ("**/"는 폴더 0개도 됨)
//   ?   / 아닌 한 글자

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(re + "$");
  cache.set(glob, compiled);
  return compiled;
}

/**
 * 프로젝트 기준 상대 경로(슬래시)가 패턴 가운데 하나에 맞는지.
 * 「!」로 시작하는 패턴은 뺄 곳이다: 맞는 패턴이 있어도 뺄 패턴에 맞으면 아니다
 * (조각 3: 구현 노드는 `mobile/**`을 고치되 디자인 시스템 `!mobile/ui/**`은 못 고침).
 */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  const out = globs.filter((g) => g.startsWith("!"));
  return globs.some((g) => !g.startsWith("!") && globToRegExp(g).test(path)) && !out.some((g) => globToRegExp(g.slice(1)).test(path));
}

/** 사람과 세션에게 보이는 writes 글: 「`src/**`, `mobile/**` (빼고: `mobile/ui/**`)」 */
export function globsText(globs: readonly string[]): string {
  const keep = globs.filter((g) => !g.startsWith("!")).map((g) => `\`${g}\``);
  const out = globs.filter((g) => g.startsWith("!")).map((g) => `\`${g.slice(1)}\``);
  return `${keep.join(", ")}${out.length ? ` (빼고: ${out.join(", ")})` : ""}`;
}
