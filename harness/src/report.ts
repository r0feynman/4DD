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
  /** 기능별 Stage 0·1 지표 (조각 2) */
  features: FeatureMetrics[];
  /** 화면 기능 지표 (조각 3). 화면 비교·기기·빌드·Figma 기록이 없으면 null */
  screens: ScreenMetrics | null;
}

export interface ScreenMetrics {
  /** 플랫폼별 N26F 첫 통과: 작업마다 첫 N26F 실행에서 그 플랫폼의 비교가 모두 통과했나 */
  firstPass: { platform: string; tasks: number; passed: number }[];
  /** N26F가 ui_mismatch로 N24에 보낸 횟수 */
  uiMismatch: number;
  /** 화면 비교 차이 비율(%)의 분포 */
  diffs: { platform: string; count: number; min: number; median: number; max: number; over: number; buckets: Record<string, number> }[];
  /** 디자인 단계로 돌아간 원인 (design_wrong, design_missing_state) */
  designReturns: Record<string, number>;
  /** 노드별 Figma 도구 호출 수 */
  figmaByNode: { node: string; read: number; write: number }[];
  /** 가상 기기 부팅 시간(초) */
  boots: number[];
  /** 플랫폼별 앱 빌드와 플로우 실행 시간(초) */
  builds: { platform: string; count: number; avgSeconds: number; maxSeconds: number }[];
  flows: { platform: string; count: number; avgSeconds: number; maxSeconds: number }[];
}

export const DIFF_BUCKETS = [
  { label: "1% 이하", max: 1 },
  { label: "1~2%", max: 2 },
  { label: "2~5%", max: 5 },
  { label: "5~10%", max: 10 },
  { label: "10% 넘음", max: Infinity },
] as const;

export interface FeatureMetrics {
  feature: string;
  /** 사람 개입 (각본 PO는 빼고): 노드·종류별 */
  humans: { node: string; kind: string; count: number }[];
  humansTotal: number;
  /** 각본 PO의 개입 (사람 개입 수에 넣지 않음) */
  scripted: number;
  /** 검토 페이지를 게시(없으면 만든) 뒤 PO의 답까지 걸린 시간 (분) */
  waits: { review: string; node: string; minutes: number }[];
  /** N04에서 PO가 되돌린 원인 */
  n04Rejects: Record<string, number>;
  /** N13·N14에서 관문이나 리뷰가 고치게 한 횟수 */
  planFails: Record<string, number>;
  /** Stage 2에서 스펙·설계로 돌아간 원인 (Stage 0·1이 놓친 것) */
  returns: Record<string, number>;
  /** 스테이지별 토큰과 시간 */
  stages: { stage: number; tokens: number; minutes: number; costUsd: number }[];
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
      humans: events.filter((e) => e.type === "human" && e.task === task && e.by !== "script").length,
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
  for (const e of events) if (e.type === "human" && e.by !== "script") inc(humans, e.node);
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
  const features = featureMetrics(events, ends, nodes);
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
    features,
    screens: screenMetrics(events, ends),
  };
}

type GateRun = Extract<LedgerEvent, { type: "gate_run" }>;

/** 화면 기능 지표 (조각 3 명세 「보고서에 더하는 것」) */
function screenMetrics(events: LedgerEvent[], ends: NodeEnd[]): ScreenMetrics | null {
  const runs = events.filter((e): e is GateRun => e.type === "gate_run");
  const visual = runs.filter((e) => !!e.scenario && !!e.platform);
  const devices = events.filter((e): e is Extract<LedgerEvent, { type: "device" }> => e.type === "device");
  const figma = ends.filter((e) => e.figma_calls);
  const timed = runs.filter((e) => e.platform && !e.scenario && e.seconds !== undefined);
  if (!visual.length && !devices.length && !figma.length && !timed.length) return null;
  const platforms = [...new Set([...visual, ...timed].map((e) => e.platform as string))].sort();

  // 작업마다 첫 N26F 실행
  const firstRun = new Map<string, string>();
  for (const e of visual) if (e.task && !firstRun.has(e.task)) firstRun.set(e.task, e.run);
  const firstPass = platforms.map((platform) => {
    const tried = [...firstRun].filter(([task, run]) => visual.some((e) => e.task === task && e.run === run && e.platform === platform));
    const passed = tried.filter(([task, run]) => visual.filter((e) => e.task === task && e.run === run && e.platform === platform).every((e) => e.result === "pass")).length;
    return { platform, tasks: tried.length, passed };
  });

  const diffs = platforms.map((platform) => {
    const xs = visual.filter((e) => e.platform === platform && e.diff_percent !== undefined).map((e) => e.diff_percent as number).sort((a, b) => a - b);
    const buckets: Record<string, number> = {};
    for (const x of xs) {
      const b = DIFF_BUCKETS.find((k) => x <= k.max)!;
      buckets[b.label] = (buckets[b.label] ?? 0) + 1;
    }
    const over = visual.filter((e) => e.platform === platform && e.diff_percent !== undefined && e.result === "fail").length;
    return { platform, count: xs.length, min: xs[0] ?? 0, median: xs.length ? xs[Math.floor((xs.length - 1) / 2)] : 0, max: xs.at(-1) ?? 0, over, buckets };
  }).filter((d) => d.count > 0);

  const designReturns: Record<string, number> = {};
  for (const e of ends) if (e.result === "fail" && (e.cause === "design_wrong" || e.cause === "design_missing_state")) designReturns[e.cause] = (designReturns[e.cause] ?? 0) + 1;

  const fig = new Map<string, { read: number; write: number }>();
  for (const e of figma) {
    const v = fig.get(e.node) ?? { read: 0, write: 0 };
    v.read += e.figma_calls!.read;
    v.write += e.figma_calls!.write;
    fig.set(e.node, v);
  }

  const timing = (pick: (e: GateRun) => boolean) =>
    platforms
      .map((platform) => {
        const xs = timed.filter((e) => e.platform === platform && pick(e)).map((e) => e.seconds as number);
        return { platform, count: xs.length, avgSeconds: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : 0, maxSeconds: xs.length ? Math.max(...xs) : 0 };
      })
      .filter((x) => x.count > 0);

  return {
    firstPass: firstPass.filter((x) => x.tasks > 0),
    uiMismatch: ends.filter((e) => e.node === "N26F" && e.result === "fail" && e.cause === "ui_mismatch").length,
    diffs,
    designReturns,
    figmaByNode: [...fig].map(([node, v]) => ({ node, ...v })).sort((a, b) => b.read + b.write - (a.read + a.write)),
    boots: devices.filter((e) => e.action === "up" && e.result === "ok" && e.boot_seconds !== undefined).map((e) => e.boot_seconds as number),
    builds: timing((e) => !!e.build),
    flows: timing((e) => !e.build),
  };
}

type Human = Extract<LedgerEvent, { type: "human" }>;
type ReviewEv = Extract<LedgerEvent, { type: "review" }>;

/** 기능별 Stage 0·1 지표. 작업은 패킷 1 → 2(N15 승인)에 담긴 T로 그 기능에 묶는다. */
function featureMetrics(events: LedgerEvent[], ends: NodeEnd[], nodes: NodeSet): FeatureMetrics[] {
  const names = [...new Set([...ends.map((e) => e.feature), ...events.map((e) => (e.type === "human" ? e.feature : undefined))].filter((f): f is string => !!f))];
  return names.map((feature) => {
    const tasks = new Set(events.flatMap((e) => (e.type === "packet" && e.feature === feature && e.boundary === "1-2" ? e.refs.filter((r) => /^T\d+$/.test(r)) : [])));
    const mine = (e: { task: string | null; feature?: string }) => (e.task ? tasks.has(e.task) : e.feature === feature);
    const hs = events.filter((e): e is Human => e.type === "human" && mine(e));
    const real = hs.filter((e) => e.by !== "script");
    const byKind = new Map<string, number>();
    for (const e of real) inc(byKind, `${e.node}|${e.kind}`);
    // 사람 대기 시간: 검토 페이지를 게시한 때(없으면 만든 때)부터 그 검토에 대한 답까지
    const reviews = events.filter((e): e is ReviewEv => e.type === "review" && e.feature === feature);
    const waits = hs
      .filter((e) => e.review)
      .map((e) => {
        const shown = reviews.filter((r) => r.id === e.review);
        const from = shown.find((r) => r.action === "published") ?? shown[0];
        return from ? { review: e.review as string, node: e.node, minutes: round((Date.parse(e.ts) - Date.parse(from.ts)) / 60_000, 1) } : null;
      })
      .filter((x): x is { review: string; node: string; minutes: number } => !!x);
    const n04Rejects: Record<string, number> = {};
    for (const e of hs) if (e.node === "N04" && e.kind === "reject") n04Rejects[e.cause ?? "-"] = (n04Rejects[e.cause ?? "-"] ?? 0) + 1;
    const planFails: Record<string, number> = {};
    for (const e of ends) if (mine(e) && (e.node === "N13" || e.node === "N14") && e.result === "fail") planFails[e.node] = (planFails[e.node] ?? 0) + 1;
    const returns: Record<string, number> = {};
    const BACK = ["spec_ambiguous", "spec_missing_state", "arch_wrong"];
    for (const e of ends) {
      if (!e.task || !tasks.has(e.task) || e.result !== "fail" || !e.cause) continue;
      if (BACK.includes(e.cause)) returns[e.cause] = (returns[e.cause] ?? 0) + 1;
    }
    // 작업 노드(N24 등)가 막혀 사람이 앞 스테이지 원인으로 바로잡은 것도 Stage 2에서 돌아간 것이다
    for (const e of hs) {
      if (e.kind !== "reclassify" || !e.task || !tasks.has(e.task) || !e.cause || !BACK.includes(e.cause)) continue;
      if (nodes.nodes[e.node]?.kind === "work") returns[e.cause] = (returns[e.cause] ?? 0) + 1;
    }
    const stageMap = new Map<number, { tokens: number; minutes: number; costUsd: number }>();
    for (const e of ends) {
      if (!mine(e)) continue;
      const st = nodes.nodes[e.node]?.stage ?? 2;
      const v = stageMap.get(st) ?? { tokens: 0, minutes: 0, costUsd: 0 };
      v.tokens += (e.tokens?.input ?? 0) + (e.tokens?.output ?? 0);
      v.minutes += e.minutes;
      v.costUsd += e.cost_usd ?? 0;
      stageMap.set(st, v);
    }
    return {
      feature,
      humans: [...byKind].map(([k, count]) => ({ node: k.split("|")[0], kind: k.split("|")[1], count })),
      humansTotal: real.length,
      scripted: hs.length - real.length,
      waits,
      n04Rejects,
      planFails,
      returns,
      stages: [...stageMap].sort((a, b) => a[0] - b[0]).map(([stage, v]) => ({ stage, tokens: v.tokens, minutes: round(v.minutes), costUsd: round(v.costUsd, 3) })),
    };
  });
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
  if (r.features.length) {
    lines.push("", "## 기능별 (Stage 0·1, 조각 2)", "", "| 기능 | 사람 개입 (노드·종류) | 각본 PO | 사람 대기 | N04 되돌림 | 관문·리뷰가 고치게 함 | Stage 2에서 돌아감 | 스테이지별 토큰·시간 |", "|---|---|---|---|---|---|---|---|");
    const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
    for (const f of r.features) {
      const hs = f.humans.map((h) => `${h.node} ${h.kind} ${h.count}`).join(", ") || "-";
      const waits = f.waits.map((w) => `${w.review} ${w.minutes}분`).join(", ") || "-";
      const st = f.stages.map((s) => `S${s.stage} ${s.tokens.toLocaleString("en-US")} · ${s.minutes}분`).join(" / ") || "-";
      lines.push(`| ${f.feature} | ${f.humansTotal}번: ${hs} | ${f.scripted}번 | ${waits} | ${kv(f.n04Rejects)} | ${kv(f.planFails)} | ${kv(f.returns)} | ${st} |`);
    }
    lines.push("", "- N04 되돌림이 잦으면 스펙 초안(N02)이 스토리를 덜 옮긴 것이고, Stage 2에서 돌아감이 있으면 Stage 0·1이 놓친 것입니다. 둘 다 N02·N13 지시문의 「주의점」 후보입니다.");
  }
  if (r.screens) {
    const sc = r.screens;
    const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "없음";
    lines.push("", "## 화면 기능 (조각 3)", "");
    lines.push(`- N26F 첫 통과: ${sc.firstPass.map((x) => `${x.platform} ${x.passed}/${x.tasks}`).join(", ") || "-"} · ui_mismatch로 N24에 보냄 ${sc.uiMismatch}번`);
    lines.push(`- 디자인 단계로 돌아감: ${kv(sc.designReturns)}`);
    lines.push(`- 가상 기기 부팅: ${sc.boots.length ? sc.boots.map((x) => `${x}초`).join(", ") : "-"}`);
    lines.push(`- 앱 빌드: ${sc.builds.map((x) => `${x.platform} ${x.count}번 평균 ${x.avgSeconds}초 (가장 길게 ${x.maxSeconds}초)`).join(", ") || "-"}`);
    lines.push(`- 플로우 실행: ${sc.flows.map((x) => `${x.platform} ${x.count}번 평균 ${x.avgSeconds}초 (가장 길게 ${x.maxSeconds}초)`).join(", ") || "-"}`);
    lines.push(`- Figma 호출 (읽기·쓰기): ${sc.figmaByNode.map((x) => `${x.node} ${x.read}·${x.write}`).join(", ") || "-"}`);
    if (sc.diffs.length) {
      lines.push("", "### 화면 비교 차이 비율 (허용 비율을 정할 근거)", "", `| 플랫폼 | 비교 | 가장 작음 | 가운데 | 가장 큼 | 허용 넘음 | ${DIFF_BUCKETS.map((b) => b.label).join(" | ")} |`, `|---|---|---|---|---|---|${DIFF_BUCKETS.map(() => "---|").join("")}`);
      for (const d of sc.diffs) lines.push(`| ${d.platform} | ${d.count} | ${d.min}% | ${d.median}% | ${d.max}% | ${d.over} | ${DIFF_BUCKETS.map((b) => d.buckets[b.label] ?? 0).join(" | ")} |`);
    }
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
