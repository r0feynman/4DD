// @S7 @R7 시나리오: 가입한 아이디와 비밀번호로 곧바로 로그인
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("@S7 가입한 아이디와 비밀번호로 곧바로 로그인", () => {
  it('아이디 "lee01", 비밀번호 "leepass12"로 로그인하면 응답 상태는 200이다', async () => {
    // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      // 조건: 아이디 "lee01", 비밀번호 "leepass12"로 가입에 성공했다
      const signup = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "lee01", password: "leepass12" },
      });
      expect(signup.statusCode).toBe(201);

      // 만일: 아이디 "lee01", 비밀번호 "leepass12"로 로그인을 요청하면
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "lee01", password: "leepass12" },
      });

      // 그러면: 응답 상태는 200이다
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
