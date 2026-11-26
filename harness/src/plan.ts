// Stage 0·1의 산출물 읽기 (조각 2 명세 「파일 형식」, 「스테이지 패킷과 기준 해시」)
//
// 스토리, 스펙, 시나리오, 설계, 작업 목록, 스프린트 파일을 읽고, 승인과 패킷에 쓸 해시를 만든다.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "./ledger.ts";
import type { Packet } from "./nodes.ts";
import { checkProject, parseFeature, parseSpec } from "./trace.ts";

export const SPEC_SECTIONS = ["목적", "요구사항", "범위 밖", "제약", "물을 것"] as const;
export const DESIGN_SECTIONS = ["구조", "API", "데이터 모델", "규칙", "기존 기능에 주는 영향"] as const;
export const SPRINT_FILE = "specs/sprint.md";

export const featurePath = (feature: string, file: string) => `specs/${feature}/${file}`;

/** `## 이름` 칸을 읽는다 (이름 → 본문) */
export function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (name !== null) out.set(name, body.join("\n").trim());
      name = m[1];
      body = [];
    } else if (name !== null) {
      body.push(line);
    }
  }
  if (name !== null) out.set(name, body.join("\n").trim());
  return out;
}

/** 칸 본문의 목록 줄 (`- …`) */
export function listItems(body: string | undefined): string[] {
  return (body ?? "")
    .split(/\r?\n/)
    .map((l) => /^\s*[-*]\s+(.+?)\s*$/.exec(l)?.[1])
    .filter((x): x is string => !!x);
}

/** 스펙의 「물을 것」 가운데 아직 답하지 않은 질문 ("없음"은 빼고) */
export function openQuestions(specText: string): string[] {
  return listItems(sections(specText).get("물을 것")).filter((q) => !/^(없음|없습니다)\.?$/.test(q));
}

export function readText(root: string, rel: string): string | null {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 기능 폴더의 .feature 파일들 (상대 경로) */
export function featureFiles(root: string, feature: string): string[] {
  const dir = join(root, "specs", feature);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".feature")).sort().map((f) => featurePath(feature, f)) : [];
}

export interface Sprint {
  goal: string;
  features: string[];
  backlog: string[];
}

export function readSprint(root: string): Sprint | null {
  const text = readText(root, SPRINT_FILE);
  if (text === null) return null;
  const s = sections(text);
  return {
    goal: (s.get("목표") ?? "").trim(),
    features: listItems(s.get("기능")).map((x) => x.replace(/`/g, "").split(/\s/)[0]),
    backlog: listItems(s.get("백로그")).map((x) => /^(T\d+)\b/.exec(x)?.[1] ?? x),
  };
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface FileHash {
  path: string;
  hash: string;
}

/** 파일들의 해시. 없는 파일은 "missing" */
export function hashFiles(root: string, rels: string[]): FileHash[] {
  return [...new Set(rels)].sort().map((path) => {
    const p = join(root, path);
    return { path, hash: existsSync(p) ? sha256(readFileSync(p)) : "missing" };
  });
}

/** 파일 목록 전체를 대표하는 해시 (검토 페이지와 패킷이 무엇을 보여 줬는지) */
export function combinedHash(files: FileHash[]): string {
  return sha256([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\0${f.hash}`).join("\n"));
}

/** 검토 페이지와 패킷에 들어갈 파일 */
export function reviewFilesFor(root: string, feature: string, items: readonly string[]): string[] {
  const files: string[] = [];
  for (const item of items) {
    if (item === "story") files.push(featurePath(feature, "story.md"));
    if (item === "spec") files.push(featurePath(feature, "spec.md"));
    if (item === "scenarios") files.push(...featureFiles(root, feature));
    if (item === "design") files.push(featurePath(feature, "design.md"));
    if (item === "tasks") files.push(featurePath(feature, "tasks.md"));
    if (item === "sprint") files.push(SPRINT_FILE);
  }
  return files;
}

type PacketEvent = Extract<LedgerEvent, { type: "packet" }>;

export function lastPacket(events: LedgerEvent[], feature: string, boundary: Packet): PacketEvent | undefined {
  return events.filter((e): e is PacketEvent => e.type === "packet" && e.feature === feature && e.boundary === boundary).at(-1);
}

/** 패킷에 고정한 파일이 지금도 같은가. 다른 파일 목록을 돌려준다 */
export function packetDrift(root: string, packet: PacketEvent): string[] {
  const now = new Map(hashFiles(root, packet.files.map((f) => f.path)).map((f) => [f.path, f.hash]));
  return packet.files.filter((f) => now.get(f.path) !== f.hash).map((f) => f.path);
}

/** 작업이 속한 기능 폴더 이름 */
export function featureOfTask(root: string, task: string): string | null {
  const t = checkProject(root).find((x) => x.tasks.some((k) => k.id === task));
  return t ? t.dir.split("/").pop() ?? null : null;
}

/** 기능의 요구사항 ID와 시나리오 ID (파일 형식 검사 없이) */
export function featureIds(root: string, feature: string): { R: string[]; S: string[] } {
  const spec = readText(root, featurePath(feature, "spec.md"));
  const R = spec ? parseSpec(spec, "spec.md").requirements.map((r) => r.id) : [];
  const S = featureFiles(root, feature).flatMap((f) => parseFeature(readText(root, f) ?? "", f).scenarios.map((s) => s.id));
  return { R, S };
}
