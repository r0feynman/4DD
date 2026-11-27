// 웹 인수 테스트 (조각 3, commands.e2e.web.run_files). 서버가 Expo 웹 빌드(mobile/dist)와 API를 같은 출처로 내보낸다.
// 화면 크기는 Figma 프레임(360×800)에 맞추고 3배로 찍는다(Android 1080×2400과 같은 크기).
import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_WEB_PORT ?? 3111);
export default defineConfig({
  testDir: "tests/e2e/web",
  workers: 1,
  reporter: "line",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 360, height: 800 }, deviceScaleFactor: 3 },
  webServer: { command: `WEB_DIST=mobile/dist PORT=${port} npx tsx src/server.ts`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 60_000 },
});
