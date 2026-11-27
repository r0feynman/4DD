// @S4 @R4 시나리오: 새 아이디와 규칙을 채우는 비밀번호로 가입
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("@S4 새 아이디와 규칙을 채우는 비밀번호로 가입", () => {
  it('아이디 "lee01", 비밀번호 "leepass12"로 가입하면 201이고 회원 "lee01"이 있다', async () => {
    // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      // 만일: 아이디 "lee01", 비밀번호 "leepass12"로 가입을 요청하면
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "lee01", password: "leepass12" },
      });

      // 그러면: 응답 상태는 201이다
      expect(res.statusCode).toBe(201);
      // 그리고: 아이디 "lee01"인 회원이 있다
      expect(accounts.has("lee01")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
