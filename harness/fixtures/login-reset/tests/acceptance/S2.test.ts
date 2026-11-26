// @S2 @R2 시나리오: 비밀번호를 5번 연속 틀리면 잠김
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("@S2 비밀번호를 5번 연속 틀리면 잠김", () => {
  it("4번 틀리면 401, 한 번 더 틀리면 423 locked", async () => {
    // 배경 — 조건: 아이디 "kim", 비밀번호 "correct-pw"인 사용자가 가입되어 있다
    const app = buildApp({
      users: [{ username: "kim", password: "correct-pw" }],
    });
    await app.ready();

    const login = () =>
      app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim", password: "wrong-pw" },
      });

    try {
      // 만일: 아이디 "kim", 비밀번호 "wrong-pw"로 로그인을 4번 요청하면
      let last;
      for (let i = 0; i < 4; i++) {
        last = await login();
      }

      // 그러면: 마지막 응답 상태는 401이다
      expect(last!.statusCode).toBe(401);

      // 만일: 아이디 "kim", 비밀번호 "wrong-pw"로 로그인을 한 번 더 요청하면
      const res = await login();

      // 그러면: 응답 상태는 423이다
      expect(res.statusCode).toBe(423);

      // 그리고: 응답 본문의 error는 "locked"이다
      expect(res.json().error).toBe("locked");
    } finally {
      await app.close();
    }
  });
});
