// @S14 @R6 시나리오: 규칙을 겨우 채우는 비밀번호로는 가입됨
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

describe("@S14 규칙을 겨우 채우는 비밀번호로는 가입됨", () => {
  it('아이디 "lee01", 비밀번호 "abcdefg1"로 가입하면 201이다', async () => {
    // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
    const app = buildApp({ accounts });
    await app.ready();

    try {
      // 만일: 아이디 "lee01", 비밀번호 "abcdefg1"로 가입을 요청하면
      const res = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: { username: "lee01", password: "abcdefg1" },
      });

      // 그러면: 응답 상태는 201이다
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
