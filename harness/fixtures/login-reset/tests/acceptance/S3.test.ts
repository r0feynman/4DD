// @S3 @R3 시나리오: 잠긴 동안에는 맞는 비밀번호도 거절하고 남은 시간을 알려 줌
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("@S3 잠긴 동안에는 맞는 비밀번호도 거절하고 남은 시간을 알려 줌", () => {
  it("잠긴 뒤 3분이 지나 맞는 비밀번호로 요청하면 423, retryAfterSec 420", async () => {
    let now = 1_700_000_000_000;
    const clock = { now: () => now };

    // 배경 — 조건: 아이디 "kim", 비밀번호 "correct-pw"인 사용자가 가입되어 있다
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
      // 조건: 아이디 "kim"이 비밀번호를 5번 연속 틀려 잠겨 있다
      for (let i = 0; i < 5; i++) {
        await login("wrong-pw");
      }

      // 그리고: 잠긴 뒤 3분이 지났다
      now += 3 * 60 * 1000;

      // 만일: 아이디 "kim", 비밀번호 "correct-pw"로 로그인을 요청하면
      const res = await login("correct-pw");

      // 그러면: 응답 상태는 423이다
      expect(res.statusCode).toBe(423);

      // 그리고: 응답 본문의 retryAfterSec는 420이다
      expect(res.json().retryAfterSec).toBe(420);
    } finally {
      await app.close();
    }
  });
});
