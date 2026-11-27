import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { globsText, globToRegExp, matchesAny } from "../src/glob.ts";
import { bashViolation, canSessionWrite, commitViolations, diffViolations, toProjectPath } from "../src/lock.ts";
import { getNode, loadNodes } from "../src/nodes.ts";

const nodes = loadNodes();
const ROOT = "/p";
const config = parseConfig('work_type: backend\ncommands: {unit: a, acceptance: b}\nlocked: ["specs/**", "4dd.config.yaml", ".4dd/**", ".codex/**"]\n');

describe("경로 패턴", () => {
  it("*는 한 폴더 안, **는 여러 폴더를 넘는다", () => {
    expect(matchesAny("src/app.ts", ["src/**"])).toBe(true);
    expect(matchesAny("src/a/b/c.ts", ["src/**"])).toBe(true);
    expect(matchesAny("srcx/app.ts", ["src/**"])).toBe(false);
    expect(matchesAny("specs/login/tasks.md", ["specs/*/tasks.md"])).toBe(true);
    expect(matchesAny("specs/a/b/tasks.md", ["specs/*/tasks.md"])).toBe(false);
    expect(matchesAny("tasks.md", ["**/tasks.md"])).toBe(true);
    expect(matchesAny("4dd.config.yaml", ["4dd.config.yaml"])).toBe(true);
    expect(matchesAny("4ddXconfig.yaml", ["4dd.config.yaml"])).toBe(false);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
  });

  it("「!」로 시작하는 패턴은 뺄 곳 (조각 3: 앱 코드는 고치되 디자인 시스템은 못 고침)", () => {
    const w = ["src/**", "mobile/**", "!mobile/theme.ts", "!mobile/ui/**"];
    expect(matchesAny("mobile/login/LoginScreen.tsx", w)).toBe(true);
    expect(matchesAny("mobile/theme.ts", w)).toBe(false);
    expect(matchesAny("mobile/ui/Button.tsx", w)).toBe(false);
    expect(matchesAny("mobile/uix/Button.tsx", w)).toBe(true);
    expect(matchesAny("src/app.ts", w)).toBe(true);
    expect(matchesAny("mobile/theme.ts", ["!mobile/theme.ts"])).toBe(false); // 뺄 곳만 있으면 아무것도 맞지 않음
    expect(globsText(w)).toBe("`src/**`, `mobile/**` (빼고: `mobile/theme.ts`, `mobile/ui/**`)");
  });
});

describe("세션이 고칠 수 있는 곳", () => {
  const n24 = getNode(nodes, "N24");
  it("노드의 writes 안이면 허용", () => {
    expect(canSessionWrite(ROOT, n24, "/p/src/app.ts").allowed).toBe(true);
    expect(canSessionWrite(ROOT, n24, "src/lockout.ts").allowed).toBe(true);
  });

  it("writes 밖, 잠긴 파일, 하네스 폴더, 프로젝트 밖은 막는다", () => {
    expect(canSessionWrite(ROOT, n24, "/p/tests/unit/app.test.ts")).toMatchObject({ allowed: false });
    expect(canSessionWrite(ROOT, n24, "/p/specs/login/login.feature").reason).toContain("고칠 수 있는 곳은 `src/**`");
    expect(canSessionWrite(ROOT, n24, "/p/.4dd/events.jsonl").reason).toContain(".4dd/는 하네스만");
    expect(canSessionWrite(ROOT, n24, "/etc/passwd").reason).toContain("프로젝트 밖");
    expect(canSessionWrite(ROOT, n24, "../other/src/a.ts").allowed).toBe(false);
  });

  it("구현 노드는 mobile/ 어디든 고치되 디자인 시스템과 앱 ID는 못 고친다 (조각 3)", () => {
    for (const id of ["N24", "N25"]) {
      const n = getNode(nodes, id);
      expect(canSessionWrite(ROOT, n, "/p/mobile/login/api.ts").allowed).toBe(true);
      expect(canSessionWrite(ROOT, n, "/p/mobile/App.tsx").allowed).toBe(true);
      for (const f of ["mobile/theme.ts", "mobile/ui/Button.tsx", "mobile/assets/fonts/NotoSansKR-Regular.ttf", "mobile/app.json"]) {
        expect(canSessionWrite(ROOT, n, `/p/${f}`).allowed, `${id} ${f}`).toBe(false);
      }
    }
    expect(canSessionWrite(ROOT, n24, "/p/mobile/ui/Button.tsx").reason).toContain("(빼고: `mobile/theme.ts`");
  });

  it("리뷰 세션은 아무것도 고칠 수 없다", () => {
    expect(canSessionWrite(ROOT, getNode(nodes, "N27"), "/p/src/app.ts").reason).toContain("고칠 수 있는 곳은 없음");
  });

  it("상대 경로로 바꾸기", () => {
    expect(toProjectPath("/p", "/p/src/a.ts")).toBe("src/a.ts");
    expect(toProjectPath("/p", "/p")).toBeNull();
    expect(toProjectPath("/p", "/q/a.ts")).toBeNull();
  });
});

describe("커밋 검사", () => {
  const ctx = { waitingHuman: false, allowLocked: false };
  it("사람이 잠긴 파일을 커밋하면 막는다", () => {
    expect(commitViolations(config, ctx, ["specs/login/spec.md", "src/a.ts"]).map((v) => v.path)).toEqual(["specs/login/spec.md"]);
  });

  it("사람 승인을 기다리는 중이거나 일부러 풀면 허용", () => {
    expect(commitViolations(config, { ...ctx, waitingHuman: true }, ["specs/login/spec.md"])).toEqual([]);
    expect(commitViolations(config, { ...ctx, allowLocked: true }, ["specs/login/spec.md"])).toEqual([]);
  });

  it("하네스 커밋은 그 노드의 writes와 원장만", () => {
    const node = getNode(nodes, "N24");
    expect(commitViolations(config, { ...ctx, node }, ["src/app.ts", ".4dd/events.jsonl"])).toEqual([]);
    expect(commitViolations(config, { ...ctx, node }, ["tests/unit/a.test.ts"]).map((v) => v.path)).toEqual(["tests/unit/a.test.ts"]);
    expect(commitViolations(config, { ...ctx, node: getNode(nodes, "N29") }, ["specs/login/tasks.md"])).toEqual([]);
  });
});

describe("셸 명령 검사", () => {
  it("기록과 브랜치를 바꾸는 git 명령은 막는다", () => {
    for (const cmd of [
      "git commit -m x",
      "git add . && git commit --no-verify -m x",
      "npm test; git push origin main",
      "git -C ../repo reset --hard",
      "GIT_DIR=x git stash",
      "cd src && git checkout -- app.ts",
      "echo $(git rebase main)",
      "/usr/bin/git tag v1",
    ]) {
      expect(bashViolation(cmd), cmd).not.toBeNull();
    }
  });

  it("읽기만 하는 git 명령과 다른 명령은 허용", () => {
    for (const cmd of ["git status", "git diff HEAD", "git log --oneline -5", "npx vitest run tests/unit", 'echo "git commit"', "ls -la", "git add -A"]) {
      expect(bashViolation(cmd), cmd).toBeNull();
    }
  });
});

describe("차례 뒤 변경 검사", () => {
  it("노드의 writes 밖 변경을 찾고, 원장과 state.json은 뺀다", () => {
    const changed = ["src/app.ts", "tests/unit/a.test.ts", ".4dd/events.jsonl", ".4dd/state.json", ".4dd/hooks/claude.json", "specs/login/spec.md"];
    expect(diffViolations(changed, getNode(nodes, "N24"))).toEqual(["tests/unit/a.test.ts", ".4dd/hooks/claude.json", "specs/login/spec.md"]);
  });
});
