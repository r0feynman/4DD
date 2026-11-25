// 원장 .4dd/events.jsonl 쓰기·읽기 (하네스 설계 ②·③, 첫 구현 조각 명세 「원장 이벤트」)
//
// 한 줄에 사실 하나를 추가만 한다. 내용은 남기지 않고 ID, 해시, 숫자만 남긴다.
// state.json과 지표는 모두 이 원장에서 다시 만든다. 원장은 기계만 쓴다.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CAUSES, NODE_ID } from "./nodes.ts";

export const SCHEMA_VERSION = 1;
export const DIR = ".4dd";
export const EVENTS_FILE = "events.jsonl";

export const eventsPath = (root: string) => join(root, DIR, EVENTS_FILE);

const Node = z.string().regex(NODE_ID);
const Task = z.string().regex(/^T\d+$/);
const Cause = z.enum(CAUSES);
const Id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}\\d+$`), `${prefix}숫자 꼴이어야 합니다`);

const Common = {
  ts: z.iso.datetime({ offset: true }),
  schema_version: z.literal(SCHEMA_VERSION),
  harness: z.string().regex(/^\d+\.\d+\.\d+$/),
};

const Loaded = z.strictObject({
  kind: z.enum(["instruction", "skill", "learning", "file"]),
  id: z.string().min(1),
  hash: z.string().min(1).optional(),
});

export const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run_start"), ...Common, run: Id("RUN"), agent: z.enum(["claude", "codex"]), feature: z.string().min(1) }),
  z.strictObject({ type: z.literal("node_start"), ...Common, id: Id("NR"), node: Node, task: Task.nullable(), session: z.string().min(1).nullable() }),
  z.strictObject({
    type: z.literal("node_end"),
    ...Common,
    id: Id("NR"),
    node: Node,
    task: Task.nullable(),
    result: z.enum(["pass", "fail", "wait"]),
    cause: Cause.optional(),
    /** N29에서 작업을 끝냈을 때 true */
    task_done: z.boolean().optional(),
    loaded: z.array(Loaded).default([]),
    tokens: z.strictObject({ input: z.number().int().min(0), output: z.number().int().min(0), cached: z.number().int().min(0).optional() }).optional(),
    cost_usd: z.number().min(0).optional(),
    minutes: z.number().min(0),
    turns: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    type: z.literal("gate_run"),
    ...Common,
    id: Id("GR"),
    node: Node,
    task: Task.nullable(),
    run: Id("NR"),
    exit: z.number().int(),
    result: z.enum(["pass", "fail"]),
    flaky_rerun: z.boolean().optional(),
    tests: z.strictObject({ total: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0).optional() }).optional(),
  }),
  z.strictObject({
    type: z.literal("hook_run"),
    ...Common,
    id: Id("HR"),
    hook: z.string().min(1),
    check: z.enum(["trace", "path", "bash", "session", "commit", "diff_lock"]),
    run: Id("NR").nullable(),
    target: z.string().optional(),
    result: z.enum(["allowed", "blocked"]),
  }),
  z.strictObject({
    type: z.literal("classify"),
    ...Common,
    run: Id("NR"),
    node: Node,
    cause: Cause,
    by: z.enum(["harness", "agent", "human"]),
    needs_human: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("human"),
    ...Common,
    id: Id("HU"),
    node: Node,
    task: Task.nullable(),
    kind: z.enum(["approve", "edit", "hint", "reject", "reclassify", "hold"]),
    reason: Cause.optional(),
    /** reclassify일 때 바로잡은 원인 */
    cause: Cause.optional(),
    minutes: z.number().min(0).optional(),
    /** 힌트 글은 .4dd/human/<id>.md에 두고 원장에는 해시만 */
    text_hash: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("commit"), ...Common, sha: z.string().regex(/^[0-9a-f]{7,40}$/), node: Node, task: Task.nullable() }),
  z.strictObject({ type: z.literal("run_end"), ...Common, run: Id("RUN"), reason: z.enum(["done", "wait_human", "error", "stopped"]) }),
]);

export type LedgerEvent = z.infer<typeof EventSchema>;
export type EventType = LedgerEvent["type"];
/** 쓰는 쪽이 채우지 않아도 되는 공통 필드를 뺀 이벤트 (기본값이 있는 필드는 빼도 된다) */
type EventInput = z.input<typeof EventSchema>;
export type NewEvent = EventInput extends infer E ? (E extends EventInput ? Omit<E, "ts" | "schema_version" | "harness"> & { ts?: string } : never) : never;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

function describe(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(맨 위)"}: ${i.message}`).join("; ");
}

/** 원장에 한 줄을 추가한다. 형식이 틀리면 쓰지 않고 던진다. */
export function appendEvent(root: string, harness: string, event: NewEvent): LedgerEvent {
  const full = { ts: new Date().toISOString(), schema_version: SCHEMA_VERSION, harness, ...event };
  const parsed = EventSchema.safeParse(full);
  if (!parsed.success) throw new LedgerError(`원장에 쓸 수 없는 이벤트입니다 (${(event as { type?: string }).type ?? "?"}): ${describe(parsed.error)}`);
  mkdirSync(join(root, DIR), { recursive: true });
  // 한 줄을 한 번에 덧붙인다. 훅과 지휘 프로그램이 같은 원장에 쓰더라도 줄이 섞이지 않게 하기 위해서다.
  appendFileSync(eventsPath(root), JSON.stringify(parsed.data) + "\n", { encoding: "utf8", flag: "a" });
  return parsed.data;
}

export interface ReadResult {
  events: LedgerEvent[];
  /** 마지막 줄이 쓰다 끊긴 경우처럼, 읽고 넘어간 문제 */
  warnings: string[];
}

/** 원장을 읽는다. 중간 줄이 깨졌으면 던지고, 마지막 줄만 깨졌으면(쓰다 끊김) 주의로 남기고 넘어간다. */
export function readEvents(root: string): ReadResult {
  const file = eventsPath(root);
  if (!existsSync(file)) return { events: [], warnings: [] };
  const lines = readFileSync(file, "utf8").split("\n");
  const lastIndex = lines.reduce((last, l, i) => (l.trim() ? i : last), -1);
  const events: LedgerEvent[] = [];
  const warnings: string[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (i === lastIndex) {
        warnings.push(`${i + 1}번째 줄(마지막 줄)이 쓰다 끊겨 읽지 않았습니다`);
        return;
      }
      throw new LedgerError(`원장 ${i + 1}번째 줄이 JSON이 아닙니다`);
    }
    const v = (raw as { schema_version?: unknown }).schema_version;
    if (typeof v === "number" && v > SCHEMA_VERSION) {
      throw new LedgerError(`원장 ${i + 1}번째 줄은 더 새 하네스가 썼습니다 (schema_version ${v})`);
    }
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) throw new LedgerError(`원장 ${i + 1}번째 줄 형식 오류: ${describe(parsed.error)}`);
    events.push(parsed.data);
  });
  return { events, warnings };
}

const ID_FIELDS: Record<string, (e: LedgerEvent) => string | undefined> = {
  RUN: (e) => (e.type === "run_start" ? e.run : undefined),
  NR: (e) => (e.type === "node_start" ? e.id : undefined),
  GR: (e) => (e.type === "gate_run" ? e.id : undefined),
  HR: (e) => (e.type === "hook_run" ? e.id : undefined),
  HU: (e) => (e.type === "human" ? e.id : undefined),
};

/** 원장에서 이 종류의 다음 ID를 정한다 (RUN, NR, GR, HR, HU). */
export function nextId(events: LedgerEvent[], prefix: keyof typeof ID_FIELDS): string {
  const pick = ID_FIELDS[prefix];
  let max = 0;
  for (const e of events) {
    const id = pick(e);
    if (id) max = Math.max(max, Number(id.slice(prefix.length)));
  }
  return `${prefix}${max + 1}`;
}
