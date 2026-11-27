// @S1 @R1 시나리오 개요: 아이디와 비밀번호로 로그인
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("@S1 아이디와 비밀번호로 로그인", () => {
  const examples = [
    { 비밀번호: "correct-pw", 상태: 200 },
    { 비밀번호: "wrong-pw", 상태: 401 },
  ];

  for (const { 비밀번호, 상태 } of examples) {
    it(`비밀번호 "${비밀번호}"이면 응답 상태는 ${상태}이다`, async () => {
      // 배경 — 조건: 아이디 "kim", 비밀번호 "correct-pw"인 사용자가 가입되어 있다
      const app = buildApp({
        users: [{ username: "kim", password: "correct-pw" }],
      });
      await app.ready();

      try {
        // 만일: 아이디 "kim", 비밀번호 "<비밀번호>"로 로그인을 요청하면
        const res = await app.inject({
          method: "POST",
          url: "/api/login",
          payload: { username: "kim", password: 비밀번호 },
        });

        // 그러면: 응답 상태는 <상태>이다
        expect(res.statusCode).toBe(상태);
      } finally {
        await app.close();
      }
    });
  }
});
