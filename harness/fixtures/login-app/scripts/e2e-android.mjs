// Maestro 플로우를 파일마다 돌린다 (조각 3, commands.e2e.android.run_files).
// 플로우마다 서버를 새로 띄워 앞 시나리오의 회원이 남지 않게 한다. 플로우가 찍은 화면은 .4dd/shots/android/<S>.png로 모은다.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = process.env.E2E_ANDROID_PORT ?? "3110";
const maestro = process.env.MAESTRO ?? join(homedir(), ".maestro", "bin", "maestro");
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
const files = process.argv.slice(2);
if (!files.length) {
  console.error("플로우 파일이 없습니다");
  process.exit(1);
}
const shots = join(root, ".4dd", "shots", "android");
mkdirSync(shots, { recursive: true });

function pngs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pngs(p) : p.endsWith(".png") ? [p] : [];
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`서버가 ${port}에서 뜨지 않았습니다`);
}

let failed = 0;
for (const file of files) {
  const id = basename(file).replace(/\.ya?ml$/, "");
  const server = spawn("npx", ["tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: port, HOST: "0.0.0.0" }, stdio: "ignore", detached: true });
  try {
    await waitUp();
    const out = join(root, ".4dd", "shots", "android-raw", id);
    rmSync(out, { recursive: true, force: true });
    const r = spawnSync(maestro, ["test", file, "--test-output-dir", out], { cwd: root, stdio: "inherit", env: { ...process.env, PATH: `${join(sdk, "platform-tools")}:${process.env.PATH}` } });
    if (r.status !== 0) failed++;
    const shot = pngs(out).find((p) => basename(p) === `${id}.png`) ?? pngs(out).at(-1);
    if (shot) copyFileSync(shot, join(shots, `${id}.png`));
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
}
process.exit(failed ? 1 : 0);
