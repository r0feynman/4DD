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
export const CONTEXT_ITEMS = ["task", "requirements", "scenarios", "design", "last_gate", "hint", "diff"] as const;
export const GATE_CHECKS = ["scenario_files_exist", "new_tests", "test_count_kept", "tdd_order", "no_new_skips", "locked_unchanged"] as const;

const NodeId = z.string().regex(NODE_ID, "노드 ID 꼴(N21, N26F …)이 아닙니다");
const CauseSchema = z.enum(CAUSES);

const OnFailSchema = z.strictObject({
  when: z.union([CauseSchema, z.array(CauseSchema).min(1)]),
  goto: z.union([NodeId, z.literal("human")]),
  then: NodeId.optional(),
});

const GateSchema = z.strictObject({
  run: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  expect: z.enum(["pass", "fail"]),
  flaky_rerun: z.boolean().optional(),
  /** any: 그 작업에서 N24(구현)가 이미 통과했으면 명령 결과를 따지지 않는다 (구현이 있는 작업으로 다시 돌아온 경우) */
  reentry: z.enum(["same", "any"]).optional(),
  checks: z.array(z.enum(GATE_CHECKS)).optional(),
});

const NodeSchema = z.strictObject({
  name: z.string().min(1),
  stage: z.number().int().min(0).max(4),
  method: z.enum(["sdd", "bdd", "tdd", "figma", "scrum"]),
  kind: z.enum(["work", "decision"]),
  actor: z.enum(["harness", "worker", "reviewer"]),
  applies_to: z.array(z.enum(WORK_TYPES)).min(1).default([...WORK_TYPES]),
  instruction: z.string().min(1).optional(),
  reads: z.array(z.enum(CONTEXT_ITEMS)).default([]),
  writes: z.array(z.string().min(1)).default([]),
  gate: GateSchema.optional(),
  on_fail: z.array(OnFailSchema).default([]),
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
    if (n.actor === "harness" && n.instruction) problems.push(`${id}: 하네스가 직접 하는 노드에는 지시문을 두지 않습니다`);
    if (n.actor !== "harness") {
      if (!n.instruction) {
        problems.push(`${id}: 세션이 하는 노드에는 지시문(instruction)이 있어야 합니다`);
      } else if (!existsSync(join(dir, n.instruction))) {
        problems.push(`${id}: 지시문 파일이 없습니다 (${n.instruction})`);
      }
    }
    if (n.actor === "worker" && !n.gate) problems.push(`${id}: 작업 세션 노드에는 끝났는지 볼 관문(gate)이 있어야 합니다`);
    if (n.kind === "decision") {
      if (!n.gate && n.actor !== "reviewer") problems.push(`${id}: 판단 노드에는 관문(gate)이나 리뷰 세션이 있어야 합니다`);
      if (n.on_fail.length === 0) problems.push(`${id}: 판단 노드에는 실패 원인별로 갈 곳(on_fail)이 있어야 합니다`);
    }
    if (n.kind === "work" && n.on_fail.length > 0) problems.push(`${id}: 작업 노드는 조건을 못 채우면 같은 노드를 다시 하므로 on_fail을 두지 않습니다`);
    if (n.next && !exists(n.next)) problems.push(`${id}: next ${n.next}는 정의되지 않은 노드입니다`);

    const seen = new Set<string>();
    for (const r of n.on_fail) {
      for (const c of Array.isArray(r.when) ? r.when : [r.when]) {
        if (seen.has(c)) problems.push(`${id}: 실패 원인 ${c}가 on_fail에 두 번 있습니다`);
        seen.add(c);
      }
      if (r.goto !== "human" && !exists(r.goto)) problems.push(`${id}: ${r.goto}는 정의되지 않은 노드입니다`);
      if (r.then && !exists(r.then)) problems.push(`${id}: then ${r.then}는 정의되지 않은 노드입니다`);
      if (r.goto === "human" && !r.then) problems.push(`${id}: 사람에게 가는 경로에는 승인 뒤 갈 곳(then)이 있어야 합니다`);
    }
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
export function nextNode(set: NodeSet, id: string, workType: WorkType): string | null {
  const n = getNode(set, id);
  if (n.next) return n.next;
  const i = set.order.indexOf(id);
  for (const candidate of set.order.slice(i + 1)) {
    if (set.nodes[candidate].applies_to.includes(workType)) return candidate;
  }
  return null;
}

/** 판단 노드가 이 원인으로 실패했을 때 갈 곳. 정의되지 않은 원인이면 null(사람이 정함). */
export function failRoute(set: NodeSet, id: string, cause: Cause): { goto: string; then?: string } | null {
  for (const r of getNode(set, id).on_fail) {
    const causes = Array.isArray(r.when) ? r.when : [r.when];
    if (causes.includes(cause)) return r.then ? { goto: r.goto, then: r.then } : { goto: r.goto };
  }
  return null;
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
