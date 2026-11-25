import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("buildApp · POST /api/login", () => {
  it("가입된 아이디와 맞는 비밀번호면 200 { ok: true }를 돌려준다", async () => {
    const app = buildApp({
      users: [{ username: "kim", password: "correct-pw" }],
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim", password: "correct-pw" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("같은 아이디로 5번째 틀린 요청에 바로 423 { error: 'locked', retryAfterSec }를 돌려준다", async () => {
    const clock = { now: () => 1_000_000 };
    const app = buildApp({
      users: [{ username: "kim", password: "correct-pw" }],
      clock,
    });
    await app.ready();

    const wrongLogin = () =>
      app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim", password: "wrong-pw" },
      });

    try {
      for (let i = 0; i < 4; i++) {
        await wrongLogin();
      }

      const res = await wrongLogin();

      expect(res.statusCode).toBe(423);
      expect(res.json()).toEqual({ error: "locked", retryAfterSec: 600 });
    } finally {
      await app.close();
    }
  });

  it("잠긴 아이디는 맞는 비밀번호를 보내도 423 { error: 'locked', retryAfterSec }를 돌려준다", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const app = buildApp({
      users: [{ username: "kim", password: "correct-pw" }],
      clock,
    });
    await app.ready();

    const login = (password: string) =>
      app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim", password },
      });

    try {
      for (let i = 0; i < 5; i++) {
        await login("wrong-pw");
      }

      now += 60_000;
      const res = await login("correct-pw");

      expect(res.statusCode).toBe(423);
      expect(res.json()).toEqual({ error: "locked", retryAfterSec: 540 });
    } finally {
      await app.close();
    }
  });

  it("10분 잠금이 풀린 뒤에는 연속 실패 수가 0으로 돌아가, 한 번 틀리면 423이 아니라 401을 돌려준다", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const app = buildApp({
      users: [{ username: "kim", password: "correct-pw" }],
      clock,
    });
    await app.ready();

    const wrongLogin = () =>
      app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim", password: "wrong-pw" },
      });

    try {
      for (let i = 0; i < 5; i++) {
        await wrongLogin();
      }

      now += 10 * 60 * 1000;
      const res = await wrongLogin();

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credentials" });
    } finally {
      await app.close();
    }
  });
});
