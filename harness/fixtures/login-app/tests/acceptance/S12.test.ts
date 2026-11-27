// @S12 @R9 @R8 시나리오 개요: 아이디 규칙에 맞지 않으면 거절하고 회원을 만들지 않음
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

const examples = [
  { username: "abc", reason: "3자" },
  { username: "lee", reason: "3자" },
  { username: "abcdefghij01234567890", reason: "21자" },
  { username: "lee_01", reason: "밑줄이 들어감" },
  { username: "lee 01", reason: "빈칸이 들어감" },
  { username: "이순신", reason: "한글" },
  { username: "", reason: "빈 아이디" },
];

describe("@S12 아이디 규칙에 맞지 않으면 거절하고 회원을 만들지 않음", () => {
  it.each(examples)(
    '아이디 "$username"($reason)로 가입하면 400 invalid_username이고 회원은 없다',
    async ({ username }) => {
      // 배경 — 조건: 아이디 "kim01", 비밀번호 "kimpass12"인 회원이 이미 가입되어 있다
      const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);
      const app = buildApp({ accounts });
      await app.ready();

      try {
        // 만일: 아이디 "<아이디>", 비밀번호 "goodpass12"로 가입을 요청하면
        const res = await app.inject({
          method: "POST",
          url: "/api/signup",
          payload: { username, password: "goodpass12" },
        });

        // 그러면: 응답 상태는 400이다
        expect(res.statusCode).toBe(400);
        // 그리고: 응답 본문의 error는 "invalid_username"이다
        expect(res.json().error).toBe("invalid_username");
        // 그리고: 아이디 "<아이디>"인 회원은 없다
        expect(accounts.has(username)).toBe(false);
      } finally {
        await app.close();
      }
    },
  );
});
