import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 작업을 시작하기 전에는 테스트가 하나도 없으므로, 테스트가 없어도 성공으로 본다.
    passWithNoTests: true,
  },
});
