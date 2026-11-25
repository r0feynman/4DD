// 4dd report: 원장만으로 개선 지표와 반복 실수·비효율 질의 결과를 낸다
// (하네스 설계 ⑥ 「개선 지표」, ③ 「반복 실수와 비효율 찾기」, 첫 구현 조각 명세 「완료 기준」).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, readEvents, type LedgerEvent } from "./ledger.ts";
import type { NodeSet } from "./nodes.ts";

type NodeEnd = Extract<LedgerEvent, { type: "node_end" }>;
type NodeStart = Extract<LedgerEvent, { type: "node_start" }>;

export interface TaskMetrics {
  task: string;
  humans: number;
  decisions: number;
  firstPass: number;
  backtracks: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  minutes: number;
  done: boolean;
}

export interface Report {
  tasks: TaskMetrics[];
  totals: { humansPerTask: number; firstPassRate: number | null; backtracksPerTask: number; tokensPerTask: number; minutesPerTask: number; costUsd: number };
  repeatedHookBlocks: { node: string; check: string; count: number }[];
  repeatedCauses: { node: string; cause: string; count: number }[];
  pingPong: { from: string; to: string; count: number }[];
  topCostNodes: { node: string; tokens: number; minutes: number; costUsd: number }[];
  instructionVersions: { node: string; hash: string; runs: number; firstTry: number }[];
  humanByNode: { node: string; count: number }[];
  byAgent: { agent: string; runs: number; passRate: number; tokens: number }[];
  /** 앞 작업의 구현으로 시나리오가 이미 통과한 작업 (작업 분해가 겹친 신호) */
  alreadyMet: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function buildReport(events: LedgerEvent[], nodes: NodeSet): Report {
  const ends = events.filter((e): e is NodeEnd => e.type === "node_end");
  const starts = new Map(events.filter((e): e is NodeStart => e.type === "node_start").map((e) => [e.id, e]));
  const taskIds = [...new Set(ends.map((e) => e.task).filter((t): t is string => !!t))];
  const isDecision = (n: string) => nodes.nodes[n]?.kind === "decision";

  // 노드 실행마다 어느 도구로 돌았나: 앞선 run_start의 agent
  const agentOf = new Map<string, string>();
  let agent = "-";
  for (const e of events) {
    if (e.type === "run_start") agent = e.agent;
    if (e.type === "node_start") agentOf.set(e.id, agent);
  }

  const tasks: TaskMetrics[] = taskIds.map((task) => {
    const mine = ends.filter((e) => e.task === task);
    const seen = new Set<string>();
    let decisions = 0;
    let firstPass = 0;
    const backtracks: Record<string, number> = {};
    for (const e of mine) {
      if (isDecision(e.node) && !seen.has(e.node)) {
        seen.add(e.node);
        decisions++;
        if (e.result === "pass") firstPass++;
      }
      if (e.result === "fail") {
        const key = e.cause ?? "관문 미충족";
        backtracks[key] = (backtracks[key] ?? 0) + 1;
      }
    }
    return {
      task,
      humans: events.filter((e) => e.type === "human" && e.task === task).length,
      decisions,
      firstPass,
      backtracks,
      tokensIn: mine.reduce((n, e) => n + (e.tokens?.input ?? 0), 0),
      tokensOut: mine.reduce((n, e) => n + (e.tokens?.output ?? 0), 0),
      tokensCached: mine.reduce((n, e) => n + (e.tokens?.cached ?? 0), 0),
      costUsd: round(mine.reduce((n, e) => n + (e.cost_usd ?? 0), 0), 3),
      minutes: round(mine.reduce((n, e) => n + e.minutes, 0)),
      done: mine.some((e) => e.task_done),
    };
  });

  const n = tasks.length || 1;
  const decisions = tasks.reduce((s, t) => s + t.decisions, 0);
  const totals = {
    humansPerTask: round(tasks.reduce((s, t) => s + t.humans, 0) / n),
    firstPassRate: decisions ? round(tasks.reduce((s, t) => s + t.firstPass, 0) / decisions) : null,
    backtracksPerTask: round(tasks.reduce((s, t) => s + Object.values(t.backtracks).reduce((a, b) => a + b, 0), 0) / n),
    tokensPerTask: Math.round(tasks.reduce((s, t) => s + t.tokensIn + t.tokensOut, 0) / n),
    minutesPerTask: round(tasks.reduce((s, t) => s + t.minutes, 0) / n),
    costUsd: round(tasks.reduce((s, t) => s + t.costUsd, 0), 3),
  };

  // 같은 노드가 같은 검사에 반복해서 막힘
  const hookBlocks = new Map<string, number>();
  for (const e of events) {
    if (e.type === "hook_run" && e.result === "blocked") inc(hookBlocks, `${(e.run && starts.get(e.run)?.node) || "-"}|${e.check}`);
  }
  // 같은 노드에서 같은 실패 원인 반복
  const causes = new Map<string, number>();
  for (const e of ends) if (e.result === "fail") inc(causes, `${e.node}|${e.cause ?? "관문 미충족"}`);
  // 판단 노드가 실패해 되돌아간 왕복 (판단 노드 → 다음에 돈 노드)
  const pairs = new Map<string, number>();
  for (const task of taskIds) {
    const mine = ends.filter((e) => e.task === task);
    mine.forEach((e, i) => {
      if (e.result === "fail" && isDecision(e.node) && mine[i + 1]) inc(pairs, `${e.node}|${mine[i + 1].node}`);
    });
  }
  // 토큰과 시간을 많이 쓴 노드
  const cost = new Map<string, { tokens: number; minutes: number; costUsd: number }>();
  for (const e of ends) {
    const c = cost.get(e.node) ?? { tokens: 0, minutes: 0, costUsd: 0 };
    c.tokens += (e.tokens?.input ?? 0) + (e.tokens?.output ?? 0);
    c.minutes += e.minutes;
    c.costUsd += e.cost_usd ?? 0;
    cost.set(e.node, c);
  }
  // 지시문 버전(해시)별로 첫 차례에 통과한 비율
  const versions = new Map<string, { runs: number; firstTry: number }>();
  const tried = new Set<string>();
  for (const e of ends) {
    const ins = e.loaded.find((l) => l.kind === "instruction");
    if (!ins) continue;
    const key = `${e.node}|${ins.hash ?? "-"}`;
    const v = versions.get(key) ?? { runs: 0, firstTry: 0 };
    v.runs++;
    const first = !tried.has(`${e.task}|${e.node}`);
    tried.add(`${e.task}|${e.node}`);
    if (first && e.result === "pass") v.firstTry++;
    versions.set(key, v);
  }
  const humans = new Map<string, number>();
  for (const e of events) if (e.type === "human") inc(humans, e.node);
  const agents = new Map<string, { runs: number; pass: number; tokens: number }>();
  for (const e of ends) {
    const a = agentOf.get(e.id) ?? "-";
    const v = agents.get(a) ?? { runs: 0, pass: 0, tokens: 0 };
    v.runs++;
    if (e.result === "pass") v.pass++;
    v.tokens += (e.tokens?.input ?? 0) + (e.tokens?.output ?? 0);
    agents.set(a, v);
  }

  const split = (k: string) => k.split("|");
  return {
    tasks,
    totals,
    repeatedHookBlocks: [...hookBlocks].filter(([, c]) => c >= 2).map(([k, count]) => ({ node: split(k)[0], check: split(k)[1], count })).sort((a, b) => b.count - a.count),
    repeatedCauses: [...causes].filter(([, c]) => c >= 2).map(([k, count]) => ({ node: split(k)[0], cause: split(k)[1], count })).sort((a, b) => b.count - a.count),
    pingPong: [...pairs].map(([k, count]) => ({ from: split(k)[0], to: split(k)[1], count })).sort((a, b) => b.count - a.count),
    topCostNodes: [...cost].map(([node, c]) => ({ node, tokens: c.tokens, minutes: round(c.minutes), costUsd: round(c.costUsd, 3) })).sort((a, b) => b.tokens - a.tokens).slice(0, 3),
    instructionVersions: [...versions].map(([k, v]) => ({ node: split(k)[0], hash: split(k)[1], ...v })).sort((a, b) => a.node.localeCompare(b.node)),
    humanByNode: [...humans].map(([node, count]) => ({ node, count })).sort((a, b) => b.count - a.count),
    byAgent: [...agents].map(([agent, v]) => ({ agent, runs: v.runs, passRate: round(v.pass / v.runs), tokens: v.tokens })),
    alreadyMet: [...new Set(ends.filter((e) => e.already_met && e.task).map((e) => e.task as string))],
  };
}

export function renderReport(r: Report): string {
  const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  const lines: string[] = ["# 4DD 개선 지표", ""];
  lines.push("## 다섯 지표", "", "| 지표 | 값 | 좋아지는 쪽 |", "|---|---|---|");
  lines.push(`| 작업당 사람 개입 수 | ${r.totals.humansPerTask} | 줄어듦 (가장 중요) |`);
  lines.push(`| 첫 통과율 (판단 노드) | ${pct(r.totals.firstPassRate)} | 늘어남 |`);
  lines.push(`| 작업당 되돌림 수 | ${r.totals.backtracksPerTask} | 줄어듦 |`);
  lines.push("| 기능당 스프린트 수 | - (조각 4에서 잼) | 줄어듦 |");
  lines.push(`| 작업당 토큰과 시간 | ${r.totals.tokensPerTask.toLocaleString("en-US")} 토큰 · ${r.totals.minutesPerTask}분 (전체 표시 가격 $${r.totals.costUsd}) | 줄어듦 |`, "");
  lines.push("## 작업별", "", "| 작업 | 끝남 | 사람 개입 | 판단 노드 첫 통과 | 되돌림 (원인별) | 토큰 입력·캐시·출력 | 시간 | 표시 가격 |", "|---|---|---|---|---|---|---|---|");
  for (const t of r.tasks) {
    const bt = Object.entries(t.backtracks).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
    lines.push(`| ${t.task} | ${t.done ? "예" : "아니오"} | ${t.humans} | ${t.firstPass}/${t.decisions} | ${bt} | ${t.tokensIn}·${t.tokensCached}·${t.tokensOut} | ${t.minutes}분 | $${t.costUsd} |`);
  }
  lines.push("", "## 반복 실수와 비효율", "");
  const list = (title: string, rows: string[]) => lines.push(`### ${title}`, "", ...(rows.length ? rows.map((x) => `- ${x}`) : ["- 없음"]), "");
  list("같은 노드가 같은 검사에 반복해서 막힘 (지시문이 잠금을 알려 주지 않는지)", r.repeatedHookBlocks.map((x) => `${x.node} · ${x.check} ${x.count}번`));
  list("같은 노드에서 같은 실패 원인 반복", r.repeatedCauses.map((x) => `${x.node} · ${x.cause} ${x.count}번`));
  list("판단 노드가 실패해 되돌아간 왕복", r.pingPong.map((x) => `${x.from} → ${x.to} ${x.count}번`));
  list("토큰을 가장 많이 쓴 노드", r.topCostNodes.map((x) => `${x.node}: ${x.tokens.toLocaleString("en-US")} 토큰 · ${x.minutes}분 · $${x.costUsd}`));
  list("지시문 버전별 첫 차례 통과 (받아도 그대로면 정리 후보)", r.instructionVersions.map((x) => `${x.node} 지시문 ${x.hash}: 차례 ${x.runs}번, 첫 차례 통과 ${x.firstTry}번`));
  list("사람 개입이 몰리는 노드", r.humanByNode.map((x) => `${x.node} ${x.count}번`));
  list("이미 충족된 작업 (앞 작업이 몫까지 구현함: 작업 분해가 겹친 신호, N14 회고 후보)", r.alreadyMet);
  list("도구별 차이", r.byAgent.map((x) => `${x.agent}: 노드 실행 ${x.runs}번 · 통과 ${pct(x.passRate)} · ${x.tokens.toLocaleString("en-US")} 토큰`));
  lines.push("찾은 것은 바로 고치지 않습니다. 개선 후보가 되어 시험 세트를 거친 뒤에만 규칙이 됩니다 (하네스 설계 ⑥).");
  return lines.join("\n") + "\n";
}

export function writeReport(root: string, nodes: NodeSet): { file: string; text: string; report: Report } {
  const report = buildReport(readEvents(root).events, nodes);
  const text = renderReport(report);
  mkdirSync(join(root, DIR), { recursive: true });
  const file = join(root, DIR, "report.md");
  writeFileSync(file, text, "utf8");
  return { file, text, report };
}
