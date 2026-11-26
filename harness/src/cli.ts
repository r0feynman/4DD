#!/usr/bin/env node
// 4dd 명령의 입구. 첫 구현 조각 명세의 「4dd 명령」을 단계마다 하나씩 채운다.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adapterFor, type Agent } from "./adapters.ts";
import { loadConfig } from "./config.ts";
import { buildContext } from "./context.ts";
import { runGate } from "./gate.ts";
import { humanAction, type HumanKind } from "./human.ts";
import { writeReport } from "./report.ts";
import { runLoop } from "./run.ts";
import { setupCodexHooks } from "./setup.ts";
import { runSessionNode } from "./turn.ts";
import { checkCommit, checkDiff } from "./guard.ts";
import { runHook, type Tool } from "./hooks.ts";
import { initProject } from "./init.ts";
import { DIR, readEvents } from "./ledger.ts";
import { bashViolation, canSessionWrite } from "./lock.ts";
import { CAUSES, getNode, loadNodes, type Cause } from "./nodes.ts";
import { loadState, type State } from "./state.ts";
import { checkProject, formatIssues, nextIds } from "./trace.ts";
import { approveReview, buildReview, recordPublished, rejectReview, tellStory, type Speaker } from "./po.ts";

const USAGE = `사용법: 4dd <명령>

  run [--agent claude|codex] [--max-tasks N] [--root 폴더]   지휘 루프. 끝나거나 사람이 필요할 때까지 돈다 (0 끝 · 3 사람 대기 · 1 오류)
  human <approve|hint|reclassify|hold> [글|원인] [--minutes N] [--root 폴더]   사람 개입을 남기고 다시 시작할 수 있게 한다
  story --feature <이름> "<PO의 말>" [--by po|dev|script] [--channel chat|terminal]   N01: 스토리를 받아 그 기능의 Stage 0을 시작한다 (PO 창구)
  review [--url <주소> [--id RV…]] [--root 폴더]   기다리는 승인(N04, N15)의 검토 페이지를 만든다. --url은 게시한 주소를 남긴다 (PO 창구)
  human approve --review <RV…> --quote "<PO의 말>"   검토 해시를 확인하고 승인, 스테이지 패킷을 남긴다 (PO 창구)
  human reject --review <RV…> (--cause <원인> | --to <노드>) --quote "<PO의 말>"   되돌린다. PO의 말은 다음 차례의 힌트와 학습 후보가 된다 (PO 창구)
  report [--root 폴더]                         원장만으로 개선 지표와 반복 실수·비효율 질의 결과 (.4dd/report.md)
  init <폴더> [--from <원본>] [--no-install]   시험 프로젝트를 새 git 저장소로 만들고 훅과 기준 해시를 건다
  setup codex [--codex-home 폴더]               Codex 사용자 설정(~/.codex/hooks.json)에 4DD 훅을 한 번 넣는다
  status [폴더] [--root 폴더]                  지금 작업과 노드, 기다리는 이유
  check trace [폴더] [--stage 0]               추적 ID(R, @S, T)가 이어져 있고 프로젝트 전체에서 겹치지 않는지 (--stage 0은 요구사항과 시나리오만)
  ids [폴더] [--json]                          프로젝트에서 다음에 쓸 R, S, T 번호
  check path <파일> --node <노드> [--root 폴더]  이 노드에서 이 파일을 고쳐도 되는지
  check bash <명령>                            셸 명령에 하네스만 할 수 있는 git 명령이 있는지
  check hook --tool <claude|codex>             훅 입구 (표준 입력의 훅 JSON을 읽음)
  check commit                                 git pre-commit 입구
  check diff --node <노드> [--run NR..] [--revert]  마지막 커밋 뒤 이 노드에서 고칠 수 없는 곳이 바뀌었는지
  gate <노드> --task <작업> [--run NR..] [--root 폴더]  관문을 돌리고 원장에 남긴다 (0 통과 · 1 실패)
  context <노드> --task <작업> [--root 폴더]   세션에 보낼 지시문과 「이번 작업」을 출력
  turn <노드> --task <작업> [--agent claude|codex] [--root 폴더]  작업 세션 노드 한 차례만 돌린다 (점검용)

종료 코드: 0 통과 · 2 막음 · 1 잘못된 사용이나 오류`;

const STATUS_WORD: Record<State["status"], string> = {
  idle: "멈춤 (다음 작업을 기다림)",
  running: "도는 중",
  waiting_human: "사람을 기다림",
  done: "끝",
  stopped: "중단됨",
};

/** --이름 값 꼴의 옵션과 나머지 인자를 가른다. */
function parseArgs(args: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opt[key] = next;
        i++;
      } else {
        opt[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, opt };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** --by, --channel: 누가 어느 통로로 (기본은 PO가 채팅으로) */
function speaker(opt: Record<string, string | true>): Speaker {
  const by = str(opt.by);
  const channel = str(opt.channel);
  if (by && !["po", "dev", "script"].includes(by)) throw new Error("--by는 po, dev, script 가운데 하나입니다");
  if (channel && !["chat", "terminal"].includes(channel)) throw new Error("--channel은 chat, terminal 가운데 하나입니다");
  return { ...(by ? { by: by as Speaker["by"] } : {}), ...(channel ? { channel: channel as Speaker["channel"] } : {}) };
}

function out(text: string): void {
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}
function err(text: string): void {
  if (text) process.stderr.write(text.endsWith("\n") ? text : text + "\n");
}

function checkTrace(dir: string | undefined, stage0 = false): number {
  const root = resolve(dir ?? ".");
  const traces = checkProject(root, stage0 ? "scenarios" : "auto");
  const report = formatIssues(traces);
  const errors = traces.reduce((n, t) => n + t.issues.filter((i) => i.level === "error").length, 0);
  const summary = traces.map((t) => `${t.dir}: 요구사항 ${t.requirements.length} · 시나리오 ${t.scenarios.length} · 작업 ${t.tasks.length}`).join("\n");
  if (errors > 0) {
    err(`${report}\n추적 검사 실패: 오류 ${errors}개`);
    return 2;
  }
  out(`${summary}\n${report ? report + "\n" : ""}추적 검사 통과`);
  return 0;
}

function status(dir: string | undefined): number {
  const root = resolve(dir ?? ".");
  if (!existsSync(join(root, DIR))) {
    out(`아직 시작하지 않았습니다 (${DIR} 폴더 없음)`);
    return 0;
  }
  const { state: s, rebuilt, warnings } = loadState(root);
  const lines = [
    `상태: ${STATUS_WORD[s.status]}`,
    `기능: ${s.feature ?? "-"} · 도구: ${s.agent ?? "-"} · 하네스 ${s.harness ?? "-"}`,
    `작업: ${s.task ?? "-"} · 노드: ${s.node ?? "-"}${s.node_run ? ` (${s.node_run})` : ""}`,
    `되돌림: 작업 전체 ${s.task_backtracks}번${Object.entries(s.fails).filter(([, n]) => n > 0).map(([k, n]) => ` · ${k} 연속 ${n}번`).join("")}`,
    `끝낸 작업: ${s.done_tasks.join(", ") || "-"}${s.held_tasks.length ? ` · 보류: ${s.held_tasks.join(", ")}` : ""}`,
  ];
  if (s.waiting) lines.push(`기다리는 이유: ${s.waiting.node}에서 ${s.waiting.reason}`);
  // 노드 시작만 있고 끝이 없으면, 지휘 프로그램이 그 노드를 돌다가 꺼졌을 수 있다.
  const { events } = readEvents(root);
  const lastStart = events.filter((e) => e.type === "node_start").at(-1);
  if (s.status === "running" && lastStart?.type === "node_start" && !events.some((e) => e.type === "node_end" && e.id === lastStart.id)) {
    lines.push(`마지막 노드 실행(${lastStart.id}, ${lastStart.node})이 끝나지 않았습니다. 지휘 프로그램이 돌고 있지 않다면 중간에 꺼진 것이고, 4dd run이 그 노드부터 다시 합니다`);
  }
  if (rebuilt && s.events > 0) lines.push("state.json을 원장에서 다시 만들었습니다");
  for (const w of warnings) lines.push(`주의: ${w}`);
  out(lines.join("\n"));
  return 0;
}

function check(sub: string | undefined, args: string[]): number {
  const { pos, opt } = parseArgs(args);
  switch (sub) {
    case "trace":
      return checkTrace(pos[0], str(opt.stage) === "0");
    case "path": {
      const nodeId = str(opt.node);
      if (!pos[0] || !nodeId) break;
      const root = resolve(str(opt.root) ?? ".");
      const d = canSessionWrite(root, getNode(loadNodes(), nodeId), pos[0]);
      if (d.allowed) {
        out("허용");
        return 0;
      }
      err(`[4DD] ${d.reason}`);
      return 2;
    }
    case "bash": {
      if (!pos.length) break;
      const why = bashViolation(pos.join(" "));
      if (!why) {
        out("허용");
        return 0;
      }
      err(`[4DD] ${why}`);
      return 2;
    }
    case "hook": {
      const tool = str(opt.tool);
      if (tool !== "claude" && tool !== "codex") break;
      const input = readFileSync(0, "utf8");
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(input || "{}") as Record<string, unknown>;
      } catch {
        err("[4DD] 훅 입력이 JSON이 아닙니다");
        return 1;
      }
      const r = runHook(tool as Tool, payload, process.env);
      err(r.message);
      return r.exitCode;
    }
    case "commit": {
      const r = checkCommit(resolve("."), process.env);
      err(r.message);
      return r.exitCode;
    }
    case "diff": {
      const nodeId = str(opt.node);
      if (!nodeId) break;
      const root = resolve(str(opt.root) ?? ".");
      const r = checkDiff(root, nodeId, str(opt.run) ?? null, opt.revert === true);
      if (r.exitCode === 0) out("고칠 수 없는 곳의 변경 없음");
      err(r.message);
      return r.exitCode;
    }
  }
  err(USAGE);
  return 1;
}

function gate(args: string[]): number {
  const { pos, opt } = parseArgs(args);
  const nodeId = pos[0];
  if (!nodeId) {
    err(USAGE);
    return 1;
  }
  const root = resolve(str(opt.root) ?? ".");
  const runId = str(opt.run) ?? (existsSync(join(root, DIR)) ? loadState(root).state.node_run : null);
  if (!runId) {
    err("[4DD] 노드 실행 ID가 없습니다. --run NR..을 주거나 4dd run 안에서 부르세요");
    return 1;
  }
  const r = runGate({ root, config: loadConfig(root), nodes: loadNodes(), nodeId, task: str(opt.task) ?? null, runId });
  (r.passed ? out : err)(r.summary);
  return r.passed ? 0 : 1;
}

function context(args: string[]): number {
  const { pos, opt } = parseArgs(args);
  const task = str(opt.task);
  if (!pos[0] || !task) {
    err(USAGE);
    return 1;
  }
  out(buildContext({ root: resolve(str(opt.root) ?? "."), nodes: loadNodes(), nodeId: pos[0], task }).prompt);
  return 0;
}

function turn(args: string[]): number {
  const { pos, opt } = parseArgs(args);
  const task = str(opt.task);
  if (!pos[0] || !task) {
    err(USAGE);
    return 1;
  }
  const root = resolve(str(opt.root) ?? ".");
  const config = loadConfig(root);
  const agent = (str(opt.agent) ?? config.agent) as Agent;
  const r = runSessionNode({ root, config, nodes: loadNodes(), nodeId: pos[0], task, adapter: adapterFor(agent) });
  const t = r.turn;
  const cost = [
    `${agent} ${r.runId}: ${t.minutes}분`,
    t.turns !== undefined ? `세션 안 차례 ${t.turns}번` : "",
    t.tokens ? `토큰 입력 ${t.tokens.input} · 캐시 읽기 ${t.tokens.cached ?? 0} · 출력 ${t.tokens.output}` : "",
    t.costUsd !== undefined ? `표시 가격 $${t.costUsd.toFixed(3)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  (r.passed ? out : err)(r.summary + "\n" + cost);
  return r.passed ? 0 : 1;
}

function init(args: string[]): number {
  const { pos, opt } = parseArgs(args);
  if (!pos[0]) {
    err(USAGE);
    return 1;
  }
  const r = initProject(pos[0], { from: str(opt.from), install: opt["no-install"] !== true });
  const config = loadConfig(r.root);
  out(
    [
      `만들었습니다: ${r.root} (첫 커밋 ${r.commit})`,
      `작업 유형 ${config.work_type} · 도구 ${config.agent} · 잠긴 파일 ${r.locked}개의 기준 해시를 고정했습니다`,
      "Codex로 돌릴 때는 한 번만 4dd setup codex를 하고, codex를 열어 /hooks에서 4DD 훅을 신뢰해 주세요",
    ].join("\n"),
  );
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "run") {
      const { opt } = parseArgs(rest);
      const r = runLoop({
        root: resolve(str(opt.root) ?? "."),
        ...(str(opt.agent) ? { agent: str(opt.agent) as Agent } : {}),
        ...(str(opt["max-tasks"]) ? { maxTasks: Number(str(opt["max-tasks"])) } : {}),
        log: (line) => out(`[4DD] ${line}`),
      });
      const fine = r.reason === "done" || r.reason === "paused";
      (fine ? out : err)(r.message);
      return fine ? 0 : r.reason === "error" ? 1 : 3;
    }
    if (cmd === "story") {
      const { pos, opt } = parseArgs(rest);
      const feature = str(opt.feature);
      if (!feature || !pos.length) {
        err('사용법: 4dd story --feature <기능 이름> "<PO의 말>" [--by po|dev|script] [--channel chat|terminal]');
        return 1;
      }
      out(tellStory(resolve(str(opt.root) ?? "."), feature, pos.join(" "), speaker(opt)));
      return 0;
    }
    if (cmd === "review") {
      const { opt } = parseArgs(rest);
      const root = resolve(str(opt.root) ?? ".");
      const url = str(opt.url);
      if (url) {
        out(recordPublished(root, url, str(opt.id)));
        return 0;
      }
      const r = buildReview(root);
      out(`${r.id} 검토 페이지를 만들었습니다: ${r.file}\n제목: ${r.title} · ${r.node} · 해시 ${r.hash.slice(0, 12)}\n아티팩트로 게시한 뒤 4dd review --url <주소>로 주소를 남기고, PO의 답은 4dd human approve|reject --review ${r.id} --quote "<PO의 말>"로 옮깁니다`);
      return 0;
    }
    if (cmd === "human" && str(parseArgs(rest).opt.review)) {
      const { pos, opt } = parseArgs(rest);
      const root = resolve(str(opt.root) ?? ".");
      const reviewId = str(opt.review)!;
      const quote = str(opt.quote) ?? pos.slice(1).join(" ");
      if (pos[0] === "approve") {
        out(approveReview(root, reviewId, quote, speaker(opt)));
        return 0;
      }
      if (pos[0] === "reject") {
        const cause = str(opt.cause);
        if (cause && !(CAUSES as readonly string[]).includes(cause)) {
          err(`실패 원인은 ${CAUSES.join(", ")} 가운데 하나입니다`);
          return 1;
        }
        out(rejectReview(root, reviewId, quote, { ...speaker(opt), ...(cause ? { cause: cause as Cause } : {}), ...(str(opt.to) ? { to: str(opt.to) } : {}) }));
        return 0;
      }
      err("검토 답은 4dd human approve|reject --review <RV…> --quote \"<PO의 말>\" 꼴입니다");
      return 1;
    }
    if (cmd === "human") {
      const { pos, opt } = parseArgs(rest);
      const kind = pos[0] as HumanKind;
      if (!["approve", "hint", "reclassify", "hold"].includes(kind)) {
        err(USAGE);
        return 1;
      }
      const minutes = str(opt.minutes);
      out(humanAction(resolve(str(opt.root) ?? "."), kind, pos.slice(1).join(" ") || undefined, minutes ? Number(minutes) : undefined));
      return 0;
    }
    if (cmd === "report") {
      const r = writeReport(resolve(str(parseArgs(rest).opt.root) ?? "."), loadNodes());
      out(`${r.text}\n(${r.file}에도 썼습니다)`);
      return 0;
    }
    if (cmd === "init") return init(rest);
    if (cmd === "setup" && rest[0] === "codex") {
      const r = setupCodexHooks(str(parseArgs(rest.slice(1)).opt["codex-home"]));
      out(`${r.changed ? "4DD 훅을 넣었습니다" : "4DD 훅이 이미 있습니다"}: ${r.file}\n이제 codex를 열고 /hooks에서 4DD 훅을 신뢰해 주세요. 하네스가 띄운 세션에서만 동작하고 다른 Codex 세션에서는 아무것도 하지 않습니다`);
      return 0;
    }
    if (cmd === "status") {
      // PO 창구 스킬은 모든 명령에 --root를 붙인다. 폴더를 위치 인자로 줘도 된다
      const { pos, opt } = parseArgs(rest);
      return status(str(opt.root) ?? pos[0]);
    }
    if (cmd === "ids") {
      const { pos, opt } = parseArgs(rest);
      const n = nextIds(resolve(str(opt.root) ?? pos[0] ?? "."));
      out(opt.json ? JSON.stringify(n) : `다음 ID: R${n.R} · S${n.S} · T${n.T}`);
      return 0;
    }
    if (cmd === "check") return check(rest[0], rest.slice(1));
    if (cmd === "gate") return gate(rest);
    if (cmd === "context") return context(rest);
    if (cmd === "turn") return turn(rest);
  } catch (e) {
    err(`[4DD] ${(e as Error).message}`);
    return 1;
  }
  err(USAGE);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
