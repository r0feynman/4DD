// 프로젝트 설정(4dd.config.yaml) 읽기 (하네스 설계 ⑤ 「실행 도구 어댑터」)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { WORK_TYPES } from "./nodes.ts";

const ConfigSchema = z.strictObject({
  work_type: z.enum(WORK_TYPES),
  profile: z.enum(["full", "lite", "spike"]).default("full"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  platforms: z.array(z.enum(["android", "ios", "web"])).optional(),
  commands: z.strictObject({
    unit: z.string().min(1),
    acceptance: z.string().min(1),
    /** 파일을 받아 그 테스트만 돌리는 명령 (작업의 시나리오만 돌릴 때). 없으면 acceptance를 쓴다 */
    run_files: z.string().min(1).optional(),
    build: z.string().min(1).optional(),
    visual: z.string().min(1).optional(),
    /** 화면 기능의 플랫폼별 명령 (조각 3): build는 앱을 빌드해 기기에 올림, run_files는 플로우·테스트 파일을 받아 돌림 */
    e2e: z
      .strictObject({
        android: z.strictObject({ build: z.string().min(1).optional(), run_files: z.string().min(1) }).optional(),
        web: z.strictObject({ build: z.string().min(1).optional(), run_files: z.string().min(1) }).optional(),
      })
      .optional(),
  }),
  locked: z.array(z.string().min(1)).default([]),
  /** 가상 기기 (조각 3, 모바일). avd 이름, SDK 경로(없으면 ANDROID_HOME, ~/Android/Sdk), 부팅 기다리는 시간 */
  device: z
    .strictObject({
      avd: z.string().min(1).optional(),
      sdk: z.string().min(1).optional(),
      boot_timeout_sec: z.number().int().min(10).optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export const CONFIG_FILE = "4dd.config.yaml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE}을 읽지 못했습니다: ${(e as Error).message}`);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${i.path.join(".") || "(맨 위)"}: ${i.message}`);
    throw new ConfigError(`${CONFIG_FILE} 형식 오류:\n- ${lines.join("\n- ")}`);
  }
  return r.data;
}

export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new ConfigError(`${CONFIG_FILE}이 없습니다: ${root}`);
  return parseConfig(readFileSync(file, "utf8"));
}
