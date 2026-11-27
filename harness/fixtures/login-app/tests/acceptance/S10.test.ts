// @S10 @R8 시나리오: 아이디가 겹쳐 거절된 가입은 기존 회원을 바꾸지 않음
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("@S10 아이디가 겹쳐 거절된 가입은 기존 회원을 바꾸지 않음", () => {
  it("거절된 비밀번호로는 401, 원래 비밀번호로는 200이다", async () => {
    // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      // 조건: 아이디 "kim01", 비밀번호 "another12"로 가입을 요청해 409로 거절되었다
      const signup = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "kim01", password: "another12" },
      });
      expect(signup.statusCode).toBe(409);

      // 만일: 아이디 "kim01", 비밀번호 "another12"로 로그인을 요청하면
      const wrong = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim01", password: "another12" },
      });
      // 그러면: 응답 상태는 401이다
      expect(wrong.statusCode).toBe(401);

      // 만일: 아이디 "kim01", 비밀번호 "kimpass12"로 로그인을 요청하면
      const right = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "kim01", password: "kimpass12" },
      });
      // 그러면: 응답 상태는 200이다
      expect(right.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
