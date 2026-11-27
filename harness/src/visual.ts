// 화면 비교 (조각 3, N26F): 인수 테스트가 찍은 화면과 N04에서 고정한 프레임 이미지를 비교한다.
//
//   찍은 화면   .4dd/shots/<플랫폼>/<S>.png   (Maestro·Playwright 플로우의 마지막 단계)
//   기준        design/frames/<S>.png         (N03F가 받고 N04 승인 패킷이 고정)
//   차이        .4dd/shots/diff/<플랫폼>/<S>.png
//
// 판정은 다른 픽셀의 비율이 허용 비율(기본 5%) 이하인가. 위 상태 표시줄과 아래 내비게이션 막대 자리는 뺀다
// (프레임은 위 32·아래 24를 비워 그림, 3배로 96·72). 허용 비율과 뺄 영역은 4dd.config.yaml의 visual에 있고 잠겨 있다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Config } from "./config.ts";
import { FRAMES_DIR } from "./design.ts";
import type { Platform } from "./plan.ts";

export const SHOTS_DIR = ".4dd/shots";

export interface VisualSettings {
  tolerancePercent: number;
  overrides: Record<string, number>;
  ignoreTop: number;
  ignoreBottom: number;
}

export function visualSettings(config?: Pick<Config, "visual">): VisualSettings {
  const v = config?.visual;
  return {
    tolerancePercent: v?.tolerance_percent ?? 5,
    overrides: v?.overrides ?? {},
    ignoreTop: v?.ignore?.top ?? 96,
    ignoreBottom: v?.ignore?.bottom ?? 72,
  };
}

export interface VisualResult {
  scenario: string;
  platform: Platform;
  ok: boolean;
  diffPercent?: number;
  tolerance: number;
  shot: string;
  frame: string;
  diff?: string;
  error?: string;
}

function readPng(file: string): PNG {
  return PNG.sync.read(readFileSync(file));
}

/** 위·아래 띠를 뺀 가운데만 */
function crop(png: PNG, top: number, bottom: number): { data: Buffer; width: number; height: number } {
  const height = Math.max(0, png.height - top - bottom);
  const row = png.width * 4;
  return { data: Buffer.from(png.data.subarray(top * row, (top + height) * row)), width: png.width, height };
}

export function compareShot(root: string, scenario: string, platform: Platform, s: VisualSettings): VisualResult {
  const tolerance = s.overrides[scenario] ?? s.tolerancePercent;
  const frame = `${FRAMES_DIR}/${scenario}.png`;
  const shot = `${SHOTS_DIR}/${platform}/${scenario}.png`;
  const base = { scenario, platform, tolerance, shot, frame };
  if (!existsSync(join(root, frame))) return { ...base, ok: false, error: `기준 프레임 이미지가 없습니다 (${frame})` };
  if (!existsSync(join(root, shot))) return { ...base, ok: false, error: `찍은 화면이 없습니다 (${shot}). 플로우 마지막에 화면을 찍었는지 봅니다` };
  const a = readPng(join(root, frame));
  const b = readPng(join(root, shot));
  if (a.width !== b.width || a.height !== b.height) {
    return { ...base, ok: false, error: `크기가 다릅니다: 프레임 ${a.width}×${a.height}, 찍은 화면 ${b.width}×${b.height}` };
  }
  const ca = crop(a, s.ignoreTop, s.ignoreBottom);
  const cb = crop(b, s.ignoreTop, s.ignoreBottom);
  const out = new PNG({ width: ca.width, height: ca.height });
  const mismatched = pixelmatch(ca.data, cb.data, out.data, ca.width, ca.height, { threshold: 0.1 });
  const diffPercent = Math.round((mismatched / (ca.width * ca.height)) * 10000) / 100;
  const diff = `${SHOTS_DIR}/diff/${platform}/${scenario}.png`;
  mkdirSync(dirname(join(root, diff)), { recursive: true });
  writeFileSync(join(root, diff), PNG.sync.write(out));
  return { ...base, ok: diffPercent <= tolerance, diffPercent, diff };
}

export function describe(r: VisualResult): string {
  if (r.error) return `${r.platform} ${r.scenario}: ${r.error}`;
  return `${r.platform} ${r.scenario}: 차이 ${r.diffPercent}% (허용 ${r.tolerance}%) ${r.ok ? "통과" : `넘음, 차이 이미지 ${r.diff} · 기준 ${r.frame} · 찍은 화면 ${r.shot}`}`;
}
