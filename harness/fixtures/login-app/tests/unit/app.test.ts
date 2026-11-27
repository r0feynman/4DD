import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("buildApp · POST /api/signup", () => {
  it("아이디·비밀번호를 내면 201 { username }을 돌려주고 failCount 0·lockedUntil null인 회원을 만든다", async () => {
    const accounts = createAccountStore();
    const app = buildApp({ accounts });
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        // R9: 성공 예시에는 아이디 규칙(영문자·숫자 4~20자)에 맞는 아이디를 쓴다.
        payload: { username: "lee01", password: "leepass12" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ username: "lee01" });

      const account = accounts.get("lee01");
      expect(account).toBeDefined();
      expect(account?.failCount).toBe(0);
      expect(account?.lockedUntil).toBeNull();
      expect(account?.passwordHash).not.toContain("leepass12");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["", "빈 문자열"],
    ["abc", "3자"],
    ["abcdefghij01234567890", "21자"],
    ["김철수님", "한글"],
    ["park_01", "밑줄"],
    ["park 01", "빈칸"],
  ])('아이디 "%s"(%s)는 400 { error: "invalid_username" }으로 거절하고 회원을 만들지 않는다', async (username) => {
    const accounts = createAccountStore();
    const app = buildApp({ accounts });
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username, password: "goodpass12" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_username" });
      expect(accounts.has(username)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("아이디 규칙에 맞지 않아 거절된 아이디로 로그인하면 401이다", async () => {
    const accounts = createAccountStore();
    const app = buildApp({ accounts });
    await app.ready();

    try {
      await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "abc", password: "goodpass12" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "abc", password: "goodpass12" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credentials" });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["lee01", "abcde12", ["min_length"]],
    ["lee01", "abcdefgh", ["letter_and_digit"]],
    ["lee12345", "LEE12345", ["not_username"]],
    ["lee01", "abc", ["min_length", "letter_and_digit"]],
  ])(
    '아이디 "%s", 비밀번호 "%s"는 400 { error: "weak_password", rules: %j }로 거절하고 회원을 만들지 않는다',
    async (username, password, rules) => {
      const accounts = createAccountStore();
      const app = buildApp({ accounts });
      await app.ready();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/signup",
          payload: { username, password },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "weak_password", rules });
        expect(accounts.has(username)).toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it("겹치는 아이디는 비밀번호가 약해도 409 username_taken으로 먼저 거절한다(판단 순서 3 → 4)", async () => {
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "kim01", password: "abc" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "username_taken" });
    } finally {
      await app.close();
    }
  });

  it("아이디 규칙에 맞지 않으면 비밀번호가 약해도 invalid_username으로 먼저 거절한다(판단 순서 2 → 4)", async () => {
    const accounts = createAccountStore();
    const app = buildApp({ accounts });
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "abc", password: "abc" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_username" });
    } finally {
      await app.close();
    }
  });
});

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
