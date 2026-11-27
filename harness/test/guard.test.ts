// 실제 프로젝트를 만들어(4dd init) 훅 입구, git pre-commit, 차례 뒤 변경 검사, 기준 해시, 원장 지키기를 확인한다.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { git, HARNESS_AUTHOR } from "../src/git.ts";
import { checkDiff } from "../src/guard.ts";
import { CLI_PATH, initProject } from "../src/init.ts";
import { appendEvent, eventsPath, readEvents } from "../src/ledger.ts";
import { baselineDiff, computeBaseline, ledgerIntact, ledgerSnapshot, writeBaseline } from "../src/lock.ts";

let root = "";
const H = "0.1.0";

function cli(args: string[], opts: { input?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd ?? root,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 사람이나 하네스가 git commit을 직접 부르는 것처럼 (pre-commit 훅이 돈다) */
function commit(message: string, env: Record<string, string> = {}) {
  const who = { GIT_AUTHOR_NAME: HARNESS_AUTHOR.name, GIT_AUTHOR_EMAIL: HARNESS_AUTHOR.email, GIT_COMMITTER_NAME: HARNESS_AUTHOR.name, GIT_COMMITTER_EMAIL: HARNESS_AUTHOR.email };
  return spawnSync("git", ["commit", "-q", "-m", message], { cwd: root, encoding: "utf8", env: { ...process.env, ...who, ...env } });
}

const hookEnv = (node: string) => ({ FOURDD_ROOT: root, FOURDD_NODE: node, FOURDD_NODE_RUN: "NR5" });
const hookRuns = () => readEvents(root).events.filter((e) => e.type === "hook_run");

beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), "4dd-guard-")), "proj");
  initProject(root, { install: false });
});

describe("4dd init", () => {
  it("훅, 기준 해시, 첫 커밋을 만든다", () => {
    for (const f of [".4dd/hooks/claude.json", ".githooks/pre-commit", ".4dd/baseline.json"]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
    // Codex 훅은 프로젝트가 아니라 사용자 설정에 한 번 넣는다 (4dd setup codex)
    expect(existsSync(join(root, ".codex/hooks.json"))).toBe(false);
    const claude = JSON.parse(readFileSync(join(root, ".4dd/hooks/claude.json"), "utf8"));
    expect(claude.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__.*figma.*");
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain("check hook --tool claude");
    expect(git(root, ["config", "core.hooksPath"]).trim()).toBe(".githooks");
    expect(git(root, ["log", "--format=%s"]).trim()).toBe("4dd init");
    expect(git(root, ["status", "--porcelain"]).trim()).toBe("");
    const baseline = JSON.parse(readFileSync(join(root, ".4dd/baseline.json"), "utf8"));
    expect(Object.keys(baseline)).toEqual(expect.arrayContaining(["specs/login/spec.md", "specs/login/login.feature", "4dd.config.yaml", ".githooks/pre-commit"]));
  });

  it("비어 있지 않은 폴더에는 만들지 않는다", () => {
    expect(() => initProject(root, { install: false })).toThrow(/비어 있지 않습니다/);
  });
});

describe("4dd status", () => {
  it("폴더를 --root로 줘도, 위치 인자로 줘도 같은 프로젝트를 본다", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "4dd-status-"));
    const byRoot = cli(["status", "--root", root], { cwd: elsewhere });
    const byPos = cli(["status", root], { cwd: elsewhere });
    expect(byRoot.stdout).not.toContain("폴더 없음");
    expect(byRoot.stdout).toBe(byPos.stdout);
  });
});

describe("훅 입구 (4dd check hook)", () => {
  it("하네스가 띄운 세션이 아니면 아무것도 하지 않는다", () => {
    const before = hookRuns().length;
    const payload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "specs/login/spec.md") }, cwd: root };
    const r = cli(["check", "hook", "--tool", "claude"], { input: JSON.stringify(payload) });
    expect(r.code).toBe(0);
    expect(hookRuns()).toHaveLength(before);
  });

  it("세션 시작을 기록한다 (훅이 켜져 있다는 증거)", () => {
    const r = cli(["check", "hook", "--tool", "codex"], { input: JSON.stringify({ hook_event_name: "SessionStart", cwd: root }), env: hookEnv("N24") });
    expect(r.code).toBe(0);
    expect(hookRuns().at(-1)).toMatchObject({ hook: "codex.session_start", check: "session", run: "NR5", result: "allowed" });
  });

  it("Claude가 N24에서 시나리오를 고치려 하면 막고 이유를 알린다", () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "specs/login/login.feature") }, cwd: root };
    const r = cli(["check", "hook", "--tool", "claude"], { input: JSON.stringify(payload), env: hookEnv("N24") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("이 노드에서 고칠 수 있는 곳은 `src/**`");
    expect(hookRuns().at(-1)).toMatchObject({ hook: "claude.pre_tool", check: "path", target: join(root, "specs/login/login.feature"), result: "blocked" });
  });

  it("Claude가 N24에서 src를 고치면 허용하고 기록한다", () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "src/app.ts") }, cwd: root };
    expect(cli(["check", "hook", "--tool", "claude"], { input: JSON.stringify(payload), env: hookEnv("N24") }).code).toBe(0);
    expect(hookRuns().at(-1)).toMatchObject({ check: "path", result: "allowed" });
  });

  it("Codex가 N23에서 패치로 src를 고치려 하면 막는다", () => {
    const patch = "*** Begin Patch\n*** Add File: tests/unit/lockout.test.ts\n+x\n*** Update File: src/app.ts\n*** End Patch";
    const payload = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch }, cwd: root };
    const r = cli(["check", "hook", "--tool", "codex"], { input: JSON.stringify(payload), env: hookEnv("N23") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("(src/app.ts)");
    expect(r.stderr).not.toContain("lockout.test.ts)");
  });

  it("셸로 커밋하려 하면 막는다", () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -am wip" }, cwd: root };
    const r = cli(["check", "hook", "--tool", "claude"], { input: JSON.stringify(payload), env: hookEnv("N24") });
    expect(r.code).toBe(2);
    expect(hookRuns().at(-1)).toMatchObject({ check: "bash", result: "blocked" });
  });
});

describe("git pre-commit (4dd check commit)", () => {
  it("사람이 잠긴 파일을 커밋하면 막고, 일부러 풀면 허용한다", () => {
    appendFileSync(join(root, "specs/login/spec.md"), "\n- R4 추가\n");
    git(root, ["add", "specs/login/spec.md"]);
    const blocked = commit("spec");
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("잠긴 파일입니다");
    expect(hookRuns().at(-1)).toMatchObject({ hook: "git.pre_commit", check: "commit", result: "blocked" });
    git(root, ["reset", "-q", "HEAD", "specs/login/spec.md"]);
    git(root, ["checkout", "--", "specs/login/spec.md"]);
  });

  it("일부러 잠금을 풀면 사람도 잠긴 파일을 커밋할 수 있다", () => {
    appendFileSync(join(root, "specs/login/spec.md"), "\n<!-- 사람이 고침 -->\n");
    git(root, ["add", "specs/login/spec.md"]);
    const r = commit("spec by human", { FOURDD_ALLOW_LOCKED: "1" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("하네스가 N24를 커밋할 때는 src만", () => {
    writeFileSync(join(root, "src/app.ts"), "export const x = 1;\n");
    git(root, ["add", "src/app.ts"]);
    const ok = commit("N24", { FOURDD_NODE: "N24" });
    expect(ok.status, ok.stderr).toBe(0);

    writeFileSync(join(root, "tests/unit/x.test.ts"), "// x\n");
    git(root, ["add", "tests/unit/x.test.ts"]);
    const bad = commit("N24", { FOURDD_NODE: "N24" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("하네스가 N24에서 커밋할 수 있는 곳은");
    git(root, ["reset", "-q", "HEAD", "tests/unit/x.test.ts"]);
  });
});

describe("차례 뒤 변경 검사와 기준 해시", () => {
  it("노드에서 고칠 수 없는 곳의 변경을 기록하고 되돌린다", () => {
    // 앞 테스트가 남긴 tests/unit/x.test.ts(새 파일)와, 셸로 고친 시나리오, src 변경
    appendFileSync(join(root, "specs/login/login.feature"), "\n# 셸로 고침\n");
    writeFileSync(join(root, "src/app.ts"), "export const x = 2;\n");
    const r = checkDiff(root, "N24", "NR5", true);
    expect(r.exitCode).toBe(2);
    expect(r.violations).toEqual(["specs/login/login.feature", "tests/unit/x.test.ts"]);
    expect(existsSync(join(root, "tests/unit/x.test.ts"))).toBe(false);
    expect(readFileSync(join(root, "specs/login/login.feature"), "utf8")).not.toContain("셸로 고침");
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toContain("x = 2");
    expect(hookRuns().filter((e) => e.type === "hook_run" && e.check === "diff_lock").map((e) => e.type === "hook_run" && e.target)).toEqual(["specs/login/login.feature", "tests/unit/x.test.ts"]);
    expect(cli(["check", "diff", "--node", "N24"]).code).toBe(0);
  });

  it("잠긴 파일이 기준 해시와 다르면 알아챈다", () => {
    const config = loadConfig(root);
    // 앞에서 사람이 잠금을 일부러 풀고 스펙을 커밋했다. 커밋은 됐어도 기준 해시와 다르므로 다음 노드를 시작할 때 걸린다.
    expect(baselineDiff(root, config)).toEqual({ changed: ["specs/login/spec.md"], added: [], removed: [] });
    // 사람 승인(4dd human approve)이 하듯 기준 해시를 새로 적으면 그대로가 된다.
    writeBaseline(root, computeBaseline(root, config));
    expect(baselineDiff(root, config)).toEqual({ changed: [], added: [], removed: [] });
    appendFileSync(join(root, "specs/login/design.md"), "\n바뀜\n");
    writeFileSync(join(root, "specs/login/new.md"), "새 파일\n");
    expect(baselineDiff(root, config)).toEqual({ changed: ["specs/login/design.md"], added: ["specs/login/new.md"], removed: [] });
    git(root, ["checkout", "--", "specs/login/design.md"]);
    git(root, ["clean", "-fq", "specs/login/new.md"]);
  });
});

describe("원장 지키기", () => {
  it("훅 실행 기록이 덧붙기만 했으면 그대로다", () => {
    const snap = ledgerSnapshot(root);
    appendEvent(root, H, { type: "hook_run", id: "HR99", hook: "claude.pre_tool", check: "path", run: "NR5", target: "src/a.ts", result: "allowed" });
    expect(ledgerIntact(root, snap).allowed).toBe(true);
  });

  it("다른 이벤트가 붙었거나 앞부분이 바뀌었으면 실패", () => {
    let snap = ledgerSnapshot(root);
    appendEvent(root, H, { type: "commit", sha: "abcdef1", node: "N24", task: "T1" });
    expect(ledgerIntact(root, snap).reason).toContain("훅 실행 기록이 아닌 줄");

    snap = ledgerSnapshot(root);
    const text = readFileSync(eventsPath(root), "utf8");
    writeFileSync(eventsPath(root), text.replace('"result":"blocked"', '"result":"allowed"'));
    expect(ledgerIntact(root, snap).reason).toContain("앞부분이 바뀌었습니다");
  });
});
