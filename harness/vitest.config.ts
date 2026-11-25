import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 시험 프로젝트(fixtures/)는 하네스가 복사해서 돌리는 원본이라, 하네스 테스트에서 직접 돌리지 않는다.
    exclude: ["fixtures/**", "node_modules/**"],
    // 관문 테스트는 실제 프로젝트에서 테스트 실행기를 여러 번 돌린다.
    testTimeout: 60_000,
  },
});
