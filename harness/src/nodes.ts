// 노드 정의(nodes.yaml) 읽기와 형식 검사 (하네스 설계 ①)
//
// nodes.yaml이 노드 정의의 유일한 원본이다. 지휘 프로그램은 여기서 다음 노드,
// 고칠 수 있는 경로, 관문, 실패 원인별로 갈 곳, 횟수 제한을 읽는다.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

/** 실패 원인 통제 어휘 (workflow.md 「실패 원인」). 단어를 더하려면 회고에서 승인받는다. */
export const CAUSES = [
  "code_bug",
  "ui_mismatch",
  "spec_ambiguous",
  "spec_missing_state",
  "design_missing_state",
  "design_wrong",
  "arch_wrong",
  "test_flaky",
  "env",
  "budget_exceeded",
] as const;
export type Cause = (typeof CAUSES)[number];

export const WORK_TYPES = ["mobile", "web", "backend", "feature"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const NODE_ID = /^N[0-9][0-9D][FW]?$/;
export const CONTEXT_ITEMS = [
  "task", "requirements", "scenarios", "design", "last_gate", "hint", "diff",
  // 조각 2 (Stage 0·1)
  "story", "spec", "other_specs", "other_designs", "src_map", "ids", "sprint", "tasks", "review_results",
  // 조각 3 (화면 기능)
  "states", "design_system",
  // 조각 3 (Stage 2의 화면 작업: 기준 화면, 플로우 파일, 화면 상태, 디자인 시스템 부품)
  "screens",
] as const;
export const GATE_CHECKS = [
  "scenario_files_exist", "new_tests", "test_count_kept", "tdd_order", "no_new_skips", "locked_unchanged",
  // 조각 2 (Stage 0·1)
  "spec_sections", "trace_scenarios", "trace_full", "design_sections", "sprint_goal", "backlog_ids", "packet_unchanged", "requirements_kept",
  // 조각 3 (화면 기능)
  "tokens_match", "code_connect_complete", "states_complete", "frames_complete", "visual_match", "app_builds",
] as const;
/** 검토 페이지에 넣을 수 있는 것 (조각 2) */
export const REVIEW_ITEMS = ["story", "spec", "scenarios", "sprint", "design", "tasks", "review_results", "states", "frames", "design_system"] as const;
export const PACKETS = ["0-1", "1-2"] as const;
export type Packet = (typeof PACKETS)[number];

const NodeId = z.string().regex(NODE_ID, "노드 ID 꼴(N21, N26F …)이 아닙니다");
const CauseSchema = z.enum(CAUSES);

const OnFailSchema = z.strictObject({
  when: z.union([CauseSchema, z.array(CauseSchema).min(1)]),
  goto: z.union([NodeId, z.literal("human")]),
  then: NodeId.optional(),
  /** true면 goto가 노드여도 사람이 먼저 승인해야 간다 (앞 스테이지로 돌아가는 원인: 스펙·설계를 고치러 감) */
  confirm: z.boolean().optional(),
});

/** 원인 단어 없이 실패했을 때 갈 곳 (N12 → N01처럼 원인을 가르지 않는 판단 노드) */
const OtherwiseSchema = z.strictObject({
  goto: z.union([NodeId, z.literal("human")]),
  then: NodeId.optional(),
});

const GateSchema = z
  .strictObject({
    run: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    expect: z.enum(["pass", "fail"]).optional(),
    flaky_rerun: z.boolean().optional(),
    /**
     * any: 그 작업에서 N24(구현)가 이미 통과했으면 명령 결과를 따지지 않는다 (구현이 있는 작업으로 다시 돌아온 경우)
     * spec_changed: 그 작업이 스펙이나 설계를 고치러 갔다 N04·N15에서 다시 승인받고 돌아온 뒤 이 노드가 아직 통과하지 않았으면,
     *   명령 결과를 따지지 않고, 새 테스트 대신 기존 테스트를 새 스펙에 맞게 고친 것도 받는다 (N23, 2026-11-26·27 실제 실행)
     */
    reentry: z.enum(["same", "any", "spec_changed"]).optional(),
    /** expect: fail인데 명령이 이미 통과하고 다른 검사도 통과하면 「이미 충족」으로 보고 이 노드로 간다 (앞 작업이 이미 구현한 경우) */
    already_met: NodeId.optional(),
    checks: z.array(z.enum(GATE_CHECKS)).optional(),
    /**
     * 화면 기능의 작업이면 run 대신(시나리오 파일을 받는 명령) 플랫폼마다 돌리는 명령 (조각 3).
     * {e2e.build}, {e2e.run_files}는 그 플랫폼의 commands.e2e, {task.scenario_files}는 그 플랫폼의 플로우 파일, {platform.all_files}는 그 플랫폼의 모든 플로우
     */
    platform_run: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** platform_run을 이 플랫폼에서만 돌린다 (조각 3: N24는 빠른 웹 플로우로 화면까지 이었는지 확인, 2026-11-27 오너 결정) */
    platforms: z.array(z.enum(["android", "web"])).min(1).optional(),
    /** 기계 검사를 통과한 뒤 리뷰 세션(L1)이 판정한다. 값은 리뷰 지시문 경로 (조각 2: N13, N14) */
    review: z.string().min(1).optional(),
  })
  .refine((g) => !g.run || g.expect, { message: "명령(run)이 있으면 expect(pass·fail)도 있어야 합니다" })
  .refine((g) => g.run || g.checks?.length || g.review, { message: "관문에는 명령, 검사, 리뷰 가운데 하나는 있어야 합니다" });

const ApproveSchema = z.strictObject({
  /** 승인되면 남기는 스테이지 패킷의 경계 */
  packet: z.enum(PACKETS),
  /** 승인하기 전에 채워야 하는 것 */
  requires: z.array(z.enum(["no_open_questions"])).default([]),
});

const NodeSchema = z.strictObject({
  name: z.string().min(1),
  stage: z.number().int().min(0).max(4),
  method: z.enum(["sdd", "bdd", "tdd", "figma", "scrum"]),
  kind: z.enum(["work", "decision"]),
  actor: z.enum(["harness", "worker", "reviewer", "human"]),
  applies_to: z.array(z.enum(WORK_TYPES)).min(1).default([...WORK_TYPES]),
  /**
   * 작업 세션을 나누는 단위. task: 작업마다 하나 (Stage 2) · stage: 기능의 스테이지마다 하나 (Stage 0·1)
   * · design: 기능의 디자인 노드(N00F·N03W·N03F)끼리 하나, 스테이지 세션과 따로 (조각 3). 없으면 Stage 2는 task, 그 앞은 stage
   */
  session: z.enum(["task", "stage", "design"]).optional(),
  /** 노드가 쓸 수 있는 Figma 도구 (조각 3): write는 그리기까지, read는 읽기만. 없으면 Figma를 열지 않음 */
  figma: z.enum(["write", "read"]).optional(),
  /** project: 프로젝트에 한 번만 도는 노드 (N00F). 이미 통과했으면 건너뜀 */
  once: z.enum(["project"]).optional(),
  instruction: z.string().min(1).optional(),
  reads: z.array(z.enum(CONTEXT_ITEMS)).default([]),
  writes: z.array(z.string().min(1)).default([]),
  gate: GateSchema.optional(),
  /** 사람 승인을 기다리는 노드: 검토 페이지에 넣을 것 */
  review: z.array(z.enum(REVIEW_ITEMS)).min(1).optional(),
  approve: ApproveSchema.optional(),
  /** 작업 노드의 사람 승인이 되돌려졌을 때 사람이 고를 수 있는 노드 (N15 → N11·N13·N14·N15) */
  on_reject: z.array(NodeId).min(1).optional(),
  on_fail: z.array(OnFailSchema).default([]),
  otherwise: OtherwiseSchema.optional(),
  next: NodeId.optional(),
  budget: z.number().int().positive().optional(),
});

const DefaultsSchema = z.strictObject({
  budget: z.number().int().positive(),
  task_budget: z.number().int().positive(),
  flaky_retries: z.number().int().min(0),
  turn_timeout_min: z.number().positive(),
});

export type NodeDef = z.infer<typeof NodeSchema> & { id: string };
export type Defaults = z.infer<typeof DefaultsSchema>;
export type OnFail = z.infer<typeof OnFailSchema>;

export interface NodeSet {
  version: string;
  defaults: Defaults;
  /** 파일에 적힌 노드 순서 */
  order: string[];
  nodes: Record<string, NodeDef>;
  /** nodes.yaml이 있는 폴더 (지시문 경로의 기준) */
  dir: string;
}

export class NodesError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`노드 정의 오류 ${problems.length}개:\n- ${problems.join("\n- ")}`);
    this.name = "NodesError";
    this.problems = problems;
  }
}

export const DEFAULT_NODES_FILE = fileURLToPath(new URL("../nodes/nodes.yaml", import.meta.url));

function zodProblems(prefix: string, err: z.ZodError): string[] {
  return err.issues.map((i) => `${prefix}${i.path.length ? "." + i.path.join(".") : ""}: ${i.message}`);
}

/** nodes.yaml 글을 읽어 검사한다. 문제가 하나라도 있으면 전부 모아 NodesError로 던진다. */
export function parseNodes(text: string, dir: string): NodeSet {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new NodesError([`YAML을 읽지 못했습니다: ${(e as Error).message}`]);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NodesError(["맨 위가 키와 값의 묶음이어야 합니다"]);
  }
  const top = raw as Record<string, unknown>;

  const version = top.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    problems.push("version: 0.1.0 꼴의 하네스 버전이 있어야 합니다");
  }
  const defaults = DefaultsSchema.safeParse(top.defaults);
  if (!defaults.success) problems.push(...zodProblems("defaults", defaults.error));

  const order: string[] = [];
  const nodes: Record<string, NodeDef> = {};
  for (const [key, value] of Object.entries(top)) {
    if (key === "version" || key === "defaults") continue;
    if (!NODE_ID.test(key)) {
      problems.push(`${key}: 알 수 없는 키입니다 (노드 ID, version, defaults만 씁니다)`);
      continue;
    }
    const parsed = NodeSchema.safeParse(value);
    if (!parsed.success) {
      problems.push(...zodProblems(key, parsed.error));
      continue;
    }
    order.push(key);
    nodes[key] = { ...parsed.data, id: key };
  }
  if (order.length === 0) problems.push("노드가 하나도 없습니다");

  // 노드 사이의 관계 검사
  const exists = (id: string) => id in nodes;
  for (const id of order) {
    const n = nodes[id];
    const bySession = n.actor === "worker" || n.actor === "reviewer";
    if (!bySession && n.instruction) problems.push(`${id}: 하네스나 사람이 하는 노드에는 지시문을 두지 않습니다`);
    if (bySession) {
      if (!n.instruction) {
        problems.push(`${id}: 세션이 하는 노드에는 지시문(instruction)이 있어야 합니다`);
      } else if (!existsSync(join(dir, n.instruction))) {
        problems.push(`${id}: 지시문 파일이 없습니다 (${n.instruction})`);
      }
    }
    if (n.gate?.review && !existsSync(join(dir, n.gate.review))) problems.push(`${id}: 리뷰 지시문 파일이 없습니다 (${n.gate.review})`);
    if (n.actor === "worker" && !n.gate) problems.push(`${id}: 작업 세션 노드에는 끝났는지 볼 관문(gate)이 있어야 합니다`);
    if (n.actor === "human" && n.gate) problems.push(`${id}: 사람이 하는 노드에는 관문을 두지 않습니다 (판정은 사람이 함)`);
    if (n.session && n.actor !== "worker") problems.push(`${id}: session은 작업 세션 노드에만 씁니다`);
    if (n.kind === "decision") {
      if (!n.gate && n.actor !== "reviewer" && n.actor !== "human") problems.push(`${id}: 판단 노드에는 관문(gate), 리뷰 세션, 사람 가운데 하나가 있어야 합니다`);
      if (n.on_fail.length === 0 && !n.otherwise) problems.push(`${id}: 판단 노드에는 실패했을 때 갈 곳(on_fail이나 otherwise)이 있어야 합니다`);
    }
    if (n.kind === "work" && n.on_fail.length > 0) problems.push(`${id}: 작업 노드는 조건을 못 채우면 같은 노드를 다시 하므로 on_fail을 두지 않습니다`);
    if (n.kind === "work" && n.otherwise) problems.push(`${id}: otherwise는 판단 노드에만 씁니다`);
    if (!!n.review !== !!n.approve) problems.push(`${id}: 사람 승인 노드에는 검토 페이지(review)와 승인(approve)이 함께 있어야 합니다`);
    if (n.actor === "human" && n.kind === "decision" && !n.approve) problems.push(`${id}: 사람이 판정하는 노드에는 승인(approve)이 있어야 합니다`);
    if (n.on_reject) {
      if (!n.approve || n.kind !== "work") problems.push(`${id}: on_reject는 사람 승인이 있는 작업 노드에만 씁니다 (판단 노드는 on_fail)`);
      for (const r of n.on_reject) {
        if (!exists(r)) problems.push(`${id}: on_reject ${r}는 정의되지 않은 노드입니다`);
        else if (nodes[r].stage !== n.stage) problems.push(`${id}: on_reject ${r}는 같은 스테이지의 노드여야 합니다`);
      }
    }
    if (n.otherwise) {
      if (n.otherwise.goto !== "human" && !exists(n.otherwise.goto)) problems.push(`${id}: otherwise ${n.otherwise.goto}는 정의되지 않은 노드입니다`);
      if (n.otherwise.then && !exists(n.otherwise.then)) problems.push(`${id}: otherwise then ${n.otherwise.then}는 정의되지 않은 노드입니다`);
      if (n.otherwise.goto === "human" && !n.otherwise.then) problems.push(`${id}: 사람에게 가는 otherwise에는 승인 뒤 갈 곳(then)이 있어야 합니다`);
    }
    if (n.next && !exists(n.next)) problems.push(`${id}: next ${n.next}는 정의되지 않은 노드입니다`);
    if (n.gate?.already_met && !exists(n.gate.already_met)) problems.push(`${id}: already_met ${n.gate.already_met}는 정의되지 않은 노드입니다`);

    const seen = new Set<string>();
    for (const r of n.on_fail) {
      for (const c of Array.isArray(r.when) ? r.when : [r.when]) {
        if (seen.has(c)) problems.push(`${id}: 실패 원인 ${c}가 on_fail에 두 번 있습니다`);
        seen.add(c);
      }
      if (r.goto !== "human" && !exists(r.goto)) problems.push(`${id}: ${r.goto}는 정의되지 않은 노드입니다`);
      if (r.then && !exists(r.then)) problems.push(`${id}: then ${r.then}는 정의되지 않은 노드입니다`);
      if (r.goto === "human" && !r.then) problems.push(`${id}: 사람에게 가는 경로에는 승인 뒤 갈 곳(then)이 있어야 합니다`);
      if (r.confirm && r.goto === "human") problems.push(`${id}: goto가 human이면 confirm은 필요 없습니다`);
      // 앞 스테이지로 돌아가는 경로는 다음 승인(패킷)에서 돌아올 곳(then)이 있어야 하고, 사람이 먼저 승인해야 한다
      if (r.goto !== "human" && exists(r.goto) && nodes[r.goto].stage < n.stage) {
        if (!r.then) problems.push(`${id}: 앞 스테이지(${r.goto})로 돌아가는 경로에는 승인 뒤 돌아올 곳(then)이 있어야 합니다`);
        if (!r.confirm) problems.push(`${id}: 앞 스테이지(${r.goto})로 돌아가는 경로는 사람이 먼저 승인해야 합니다 (confirm: true)`);
      }
    }
  }
  // 사람 승인 노드는 경계마다 하나씩
  for (const p of PACKETS) {
    const owners = order.filter((id) => nodes[id].approve?.packet === p);
    if (owners.length > 1) problems.push(`패킷 ${p}을 남기는 승인 노드가 여럿입니다: ${owners.join(", ")}`);
  }

  if (problems.length > 0) throw new NodesError(problems);
  return { version: version as string, defaults: defaults.data as Defaults, order, nodes, dir };
}

export function loadNodes(file: string = DEFAULT_NODES_FILE): NodeSet {
  return parseNodes(readFileSync(file, "utf8"), dirname(file));
}

export function getNode(set: NodeSet, id: string): NodeDef {
  const n = set.nodes[id];
  if (!n) throw new Error(`정의되지 않은 노드입니다: ${id}`);
  return n;
}

/** 통과한 뒤 갈 노드. next가 있으면 그것, 없으면 파일 순서에서 이 작업 유형에 켜지는 다음 노드. 끝이면 null. */
export function nextNode(set: NodeSet, id: string, workType: WorkType, skip?: (node: string) => boolean): string | null {
  const n = getNode(set, id);
  if (n.next) return n.next;
  const i = set.order.indexOf(id);
  for (const candidate of set.order.slice(i + 1)) {
    if (set.nodes[candidate].applies_to.includes(workType) && !skip?.(candidate)) return candidate;
  }
  return null;
}

/** once: project인 노드(N00F)가 이 프로젝트에서 이미 통과했는가 (조각 3). nextNode의 skip으로 쓴다 */
export function onceDone(set: NodeSet, events: readonly { type: string; node?: string; result?: string }[]): (node: string) => boolean {
  return (node) => set.nodes[node]?.once === "project" && events.some((e) => e.type === "node_end" && e.node === node && e.result === "pass");
}

export interface Route {
  goto: string;
  then?: string;
  /** 사람이 먼저 승인해야 감 */
  confirm?: boolean;
}

/** 판단 노드가 이 원인으로 실패했을 때 갈 곳. 정의되지 않은 원인이면 null(사람이 정함). */
export function failRoute(set: NodeSet, id: string, cause: Cause): Route | null {
  for (const r of getNode(set, id).on_fail) {
    const causes = Array.isArray(r.when) ? r.when : [r.when];
    if (causes.includes(cause)) return { goto: r.goto, ...(r.then ? { then: r.then } : {}), ...(r.confirm ? { confirm: true } : {}) };
  }
  return null;
}

/**
 * 사람이 원인을 정했을 때 갈 곳. 판단 노드는 자기 경로를 쓴다. 작업 노드(N23~N25)는 경로가 없으므로,
 * 같은 스테이지에서 그 뒤에 오는 판단 노드 가운데 그 원인을 다루는 첫 노드의 경로를 쓴다
 * (예: N24가 횟수 제한을 넘었는데 사람이 spec_ambiguous로 바로잡으면 N26의 경로 → N02, then N22).
 * workflow.md 「횟수 제한」: 한도를 넘으면 사람이 분류를 바로잡거나 스펙을 고칠 수 있다.
 */
export function stageRoute(set: NodeSet, id: string, cause: Cause): Route | null {
  const own = failRoute(set, id, cause);
  if (own || getNode(set, id).kind !== "work") return own;
  const stage = getNode(set, id).stage;
  const after = set.order.slice(set.order.indexOf(id) + 1);
  for (const other of after) {
    const n = set.nodes[other];
    if (n.stage !== stage || n.kind !== "decision") continue;
    const r = failRoute(set, other, cause);
    if (r) return r;
  }
  return null;
}

/** 앞 스테이지(스펙, 설계)로 가는 경로인가 */
export function goesBack(set: NodeSet, id: string, r: Route | null): boolean {
  return !!r && r.goto !== "human" && !!set.nodes[r.goto] && set.nodes[r.goto].stage < getNode(set, id).stage;
}

/** 작업 세션을 나누는 단위 */
export function sessionScope(n: NodeDef): "task" | "stage" | "design" {
  return n.session ?? (n.stage >= 2 ? "task" : "stage");
}

/** 이 경계의 패킷을 남기는 승인 노드 */
export function approvalNode(set: NodeSet, packet: Packet): string | null {
  return set.order.find((id) => set.nodes[id].approve?.packet === packet) ?? null;
}

/** 노드의 writes에서 {feature}를 지금 기능 폴더 이름으로 바꾼다 */
export function resolveWrites(n: NodeDef, feature: string | null): string[] {
  return n.writes.flatMap((w) => (w.includes("{feature}") ? (feature ? [w.replaceAll("{feature}", feature)] : []) : [w]));
}

/** 지금 기능으로 writes를 풀어 둔 노드 정의 (잠금 검사는 늘 이것으로 한다) */
export function nodeFor(set: NodeSet, id: string, feature: string | null | undefined): NodeDef {
  const n = getNode(set, id);
  return { ...n, writes: resolveWrites(n, feature ?? null) };
}

/** 이 노드에서 고를 수 있는 실패 원인 (분류 차례에서 에이전트에게 보여 줄 단어). */
export function allowedCauses(set: NodeSet, id: string): Cause[] {
  return getNode(set, id).on_fail.flatMap((r) => (Array.isArray(r.when) ? r.when : [r.when]));
}

export function budgetFor(set: NodeSet, id: string): number {
  return getNode(set, id).budget ?? set.defaults.budget;
}

export function instructionPath(set: NodeSet, id: string): string | null {
  const n = getNode(set, id);
  return n.instruction ? join(set.dir, n.instruction) : null;
}
