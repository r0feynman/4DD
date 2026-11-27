// 앱을 Expo 웹으로 내보낸다 (조각 3, commands.e2e.web.build). 서버가 이 폴더를 같은 출처로 내보내므로 API 주소는 비워 둔다.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const mobile = join(resolve(import.meta.dirname, ".."), "mobile");
execFileSync("npx", ["expo", "export", "-p", "web", "--output-dir", "dist"], { cwd: mobile, env: { ...process.env, EXPO_PUBLIC_API_URL: "" }, stdio: "inherit" });
