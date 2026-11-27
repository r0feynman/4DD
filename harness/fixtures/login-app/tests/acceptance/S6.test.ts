// @S6 @R6 시나리오 개요: 규칙을 채우지 못하는 비밀번호로 가입하면 거절하고 못 채운 규칙을 알려 줌
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

const examples = [
  { username: "lee01", password: "abcde12", rules: ["min_length"] },
  { username: "lee01", password: "abcdefgh", rules: ["letter_and_digit"] },
  { username: "lee01", password: "12345678", rules: ["letter_and_digit"] },
  { username: "lee12345", password: "LEE12345", rules: ["not_username"] },
  { username: "lee01", password: "abc", rules: ["min_length", "letter_and_digit"] },
];

describe("@S6 규칙을 채우지 못하는 비밀번호로 가입하면 거절하고 못 채운 규칙을 알려 줌", () => {
  it.each(examples)(
    '아이디 "$username", 비밀번호 "$password"로 가입하면 400 weak_password이고 못 채운 규칙만 알려 준다',
    async ({ username, password, rules }) => {
      // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
      const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
      const app = buildApp({ accounts });
      await app.ready();

      try {
        // 만일: 아이디 "<아이디>", 비밀번호 "<비밀번호>"로 가입을 요청하면
        const res = await app.inject({
          method: "POST",
          url: "/api/signup",
          payload: { username, password },
        });

        // 그러면: 응답 상태는 400이다
        expect(res.statusCode).toBe(400);
        // 그리고: 응답 본문의 error는 "weak_password"이다
        expect(res.json().error).toBe("weak_password");
        // 그리고: 응답 본문의 rules는 정확히 [<못 채운 규칙>]이다
        expect(res.json().rules).toEqual(rules);
      } finally {
        await app.close();
      }
    },
  );
});
