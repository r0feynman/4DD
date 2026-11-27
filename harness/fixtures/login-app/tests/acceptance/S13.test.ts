// @S13 @R9 시나리오 개요: 아이디 규칙에 맞는 아이디는 길이 끝값까지 가입됨
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAccountStore } from "../../src/accounts.js";

const examples = [
  { username: "park", reason: "4자" },
  { username: "abcd", reason: "4자" },
  { username: "abcdefghij0123456789", reason: "20자" },
  { username: "Park2025", reason: "영문 대문자와 숫자" },
];

describe("@S13 아이디 규칙에 맞는 아이디는 길이 끝값까지 가입됨", () => {
  it.each(examples)('아이디 "$username"($reason)로 가입하면 201이다', async ({ username }) => {
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

      // 그러면: 응답 상태는 201이다
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
