// @S5 @R5 시나리오: 이미 쓰이는 아이디로 가입하면 거절
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("@S5 이미 쓰이는 아이디로 가입하면 거절", () => {
  it('아이디 "kim01", 비밀번호 "another12"로 가입하면 409이고 error는 "username_taken"이다', async () => {
    // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      // 만일: 아이디 "kim01", 비밀번호 "another12"로 가입을 요청하면
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "kim01", password: "another12" },
      });

      // 그러면: 응답 상태는 409이다
      expect(res.statusCode).toBe(409);
      // 그리고: 응답 본문의 error는 "username_taken"이다
      expect(res.json().error).toBe("username_taken");
    } finally {
      await app.close();
    }
  });
});
