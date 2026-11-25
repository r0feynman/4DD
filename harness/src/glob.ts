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

/** 프로젝트 기준 상대 경로(슬래시)가 패턴 가운데 하나에 맞는지 */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
