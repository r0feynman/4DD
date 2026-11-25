#!/usr/bin/env node
// 4dd 명령의 입구. 첫 구현 조각 명세의 「4dd 명령」을 단계마다 하나씩 채운다.
// 지금 있는 것: 4dd check trace, 4dd status

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DIR } from "./ledger.ts";
import { loadState, type State } from "./state.ts";
import { checkProject, formatIssues } from "./trace.ts";

const USAGE = `사용법: 4dd <명령>

  check trace [프로젝트 폴더]   specs/ 아래 기능마다 추적 ID(R, @S, T)가 이어져 있는지 검사
  status [프로젝트 폴더]        지금 작업과 노드, 기다리는 이유

종료 코드: 0 통과 · 2 막음(오류 있음) · 1 잘못된 사용`;

const STATUS_WORD: Record<State["status"], string> = {
  idle: "멈춤 (다음 작업을 기다림)",
  running: "도는 중",
  waiting_human: "사람을 기다림",
  done: "끝",
  stopped: "중단됨",
};

function checkTrace(dir: string | undefined): number {
  const root = resolve(dir ?? ".");
  const traces = checkProject(root);
  const report = formatIssues(traces);
  const errors = traces.reduce((n, t) => n + t.issues.filter((i) => i.level === "error").length, 0);
  const summary = traces
    .map((t) => `${t.dir}: 요구사항 ${t.requirements.length} · 시나리오 ${t.scenarios.length} · 작업 ${t.tasks.length}`)
    .join("\n");
  if (errors > 0) {
    process.stderr.write(`${report}\n추적 검사 실패: 오류 ${errors}개\n`);
    return 2;
  }
  process.stdout.write(`${summary}\n${report ? report + "\n" : ""}추적 검사 통과\n`);
  return 0;
}

function status(dir: string | undefined): number {
  const root = resolve(dir ?? ".");
  if (!existsSync(join(root, DIR))) {
    process.stdout.write(`아직 시작하지 않았습니다 (${DIR} 폴더 없음)\n`);
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
  if (rebuilt && s.events > 0) lines.push("state.json을 원장에서 다시 만들었습니다");
  for (const w of warnings) lines.push(`주의: ${w}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "check" && rest[0] === "trace") return checkTrace(rest[1]);
  if (cmd === "status") return status(rest[0]);
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
