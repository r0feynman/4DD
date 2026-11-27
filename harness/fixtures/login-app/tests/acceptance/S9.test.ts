// @S9 @R8 시나리오: 비밀번호 때문에 거절된 가입은 회원을 만들지 않음
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("@S9 비밀번호 때문에 거절된 가입은 회원을 만들지 않음", () => {
  it('거절된 아이디 "lee01"로 로그인하면 401이고 회원은 없다', async () => {
    // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      // 조건: 아이디 "lee01", 비밀번호 "abc"로 가입을 요청해 400으로 거절되었다
      const signup = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "lee01", password: "abc" },
      });
      expect(signup.statusCode).toBe(400);

      // 만일: 아이디 "lee01", 비밀번호 "abc"로 로그인을 요청하면
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "lee01", password: "abc" },
      });

      // 그러면: 응답 상태는 401이다
      expect(res.statusCode).toBe(401);
      // 그리고: 아이디 "lee01"인 회원은 없다
      expect(accounts.has("lee01")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
