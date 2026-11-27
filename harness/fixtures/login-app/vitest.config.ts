import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 앱 단위 테스트(tests/unit/mobile)와 앱 코드(mobile/)가 react·react-native를 같은 곳에서 찾게 한다.
  // 다르면 테스트의 vi.mock("react-native")이 앱 코드의 import와 맞물리지 않아, node가 읽지 못하는 진짜 react-native를 불러 깨진다 (조각 3 실제 실행).
  resolve: {
    alias: {
      "react-native": resolve(import.meta.dirname, "mobile/node_modules/react-native"),
      react: resolve(import.meta.dirname, "mobile/node_modules/react"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // 작업을 시작하기 전에는 테스트가 하나도 없으므로, 테스트가 없어도 성공으로 본다.
    passWithNoTests: true,
  },
});
