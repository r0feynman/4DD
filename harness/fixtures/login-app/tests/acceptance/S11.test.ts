// @S11 @R5 시나리오 개요: 대소문자만 다른 아이디도 이미 쓰이는 것으로 보고 거절
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

const examples = [{ username: "Kim01" }, { username: "KIM01" }];

describe("@S11 대소문자만 다른 아이디도 이미 쓰이는 것으로 보고 거절", () => {
  it.each(examples)(
    '아이디 "$username"로 가입하면 409, "username_taken"이고 회원이 새로 만들어지지 않는다',
    async ({ username }) => {
      // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
      const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
      const app = buildApp({ accounts });
      await app.ready();

      try {
        // 만일: 아이디 "<아이디>", 비밀번호 "another12"로 가입을 요청하면
        const res = await app.inject({
          method: "POST",
          url: "/api/signup",
          payload: { username, password: "another12" },
        });

        // 그러면: 응답 상태는 409이다
        expect(res.statusCode).toBe(409);
        // 그리고: 응답 본문의 error는 "username_taken"이다
        expect(res.json().error).toBe("username_taken");
        // 그리고: 아이디 "<아이디>"인 회원은 새로 만들어지지 않는다
        expect(accounts.has(username)).toBe(false);
      } finally {
        await app.close();
      }
    },
  );
});
