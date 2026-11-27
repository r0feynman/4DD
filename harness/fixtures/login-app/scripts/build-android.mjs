// 앱을 Android release로 빌드해 가상 기기에 올린다 (조각 3, commands.e2e.android.build).
// 자바스크립트를 함께 묶으므로 개발 서버 없이 돈다. 앱은 PC 서버를 10.0.2.2:<E2E_ANDROID_PORT>로 부른다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mobile = join(root, "mobile");
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
const jdk = process.env.JAVA_HOME ?? (existsSync(join(homedir(), ".local", "jdks", "jdk-17")) ? join(homedir(), ".local", "jdks", "jdk-17") : undefined);
const port = process.env.E2E_ANDROID_PORT ?? "3110";
const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ...(jdk ? { JAVA_HOME: jdk, PATH: `${join(jdk, "bin")}:${process.env.PATH}` } : {}),
  EXPO_PUBLIC_API_URL: `http://10.0.2.2:${port}`,
};
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, stdio: "inherit" });

if (!existsSync(join(mobile, "android"))) run("npx", ["expo", "prebuild", "-p", "android", "--no-install"], mobile);
run("./gradlew", ["assembleRelease", "--console=plain", "-q"], join(mobile, "android"));
const apkDir = join(mobile, "android", "app", "build", "outputs", "apk", "release");
const apk = readdirSync(apkDir).find((f) => f.endsWith(".apk"));
if (!apk) throw new Error(`APK가 없습니다: ${apkDir}`);
run(join(sdk, "platform-tools", "adb"), ["install", "-r", join(apkDir, apk)], root);
console.log(`설치했습니다: ${apk}`);
