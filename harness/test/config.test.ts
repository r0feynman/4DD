import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "login-backend");

describe("4dd.config.yaml", () => {
  it("시험 프로젝트 설정을 읽는다", () => {
    const c = loadConfig(fixture);
    expect(c.work_type).toBe("backend");
    expect(c.agent).toBe("claude");
    expect(c.commands.unit).toBe("npx vitest run tests/unit");
    expect(c.locked).toContain("specs/**");
  });

  it("기본값을 채운다", () => {
    const c = parseConfig("work_type: web\ncommands: {unit: a, acceptance: b}\n");
    expect(c.profile).toBe("full");
    expect(c.agent).toBe("claude");
    expect(c.locked).toEqual([]);
  });

  it("틀린 값과 빠진 명령을 잡는다", () => {
    expect(() => parseConfig("work_type: desktop\ncommands: {unit: a, acceptance: b}\n")).toThrow(ConfigError);
    expect(() => parseConfig("work_type: web\ncommands: {unit: a}\n")).toThrow(/commands.acceptance/);
    expect(() => loadConfig("/없는/폴더")).toThrow(/4dd.config.yaml이 없습니다/);
  });
});
