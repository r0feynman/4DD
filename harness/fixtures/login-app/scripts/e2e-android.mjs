// Maestro 플로우를 파일마다 돌린다 (조각 3, commands.e2e.android.run_files).
// 플로우마다 서버를 새로 띄워 앞 시나리오의 회원이 남지 않게 한다. 플로우가 찍은 화면은 .4dd/shots/android/<S>.png로 모은다.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

async function waitUp(server) {
  for (let i = 0; i < 60; i++) {
    // 새 서버가 포트를 잡지 못해 꺼졌으면, 응답하는 것은 다른(앞 실행이 남긴) 서버다
    if (server.exitCode !== null) throw new Error(`서버가 ${port}를 잡지 못하고 꺼졌습니다 (다른 서버가 그 포트를 쓰고 있음)`);
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`서버가 ${port}에서 뜨지 않았습니다`);
}

// 띄운 서버의 프로세스 묶음 번호를 적어 둔다. 이 스크립트가 시간 제한으로 끊기면 finally가 돌지 않아 서버가 남고,
// 다음 실행의 플로우가 옛 코드의 서버에 붙는다 (조각 3 실제 실행: 새 시험 경로가 없다며 실패). 다음 시작 때 그 서버를 끈다
const pidFile = join(shots, "..", "e2e-android-server.pid"); // .4dd/shots/ (git이 무시함)
function stopServer(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}
function stopLeftover() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  let ours = false;
  try {
    ours = readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("src/server.ts");
  } catch {}
  if (pid > 0 && ours) {
    console.error(`[e2e-android] 앞 실행이 남긴 서버(${pid})를 끕니다`);
    stopServer(pid);
    spawnSync("sleep", ["1"]);
  }
  rmSync(pidFile, { force: true });
}
let current = null;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (current) stopServer(current);
    rmSync(pidFile, { force: true });
    process.exit(143);
  });
}
stopLeftover();

let failed = 0;
for (const file of files) {
  const id = basename(file).replace(/\.ya?ml$/, "");
  const server = spawn("npx", ["tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: port, HOST: "0.0.0.0" }, stdio: "ignore", detached: true });
  current = server.pid;
  writeFileSync(pidFile, String(server.pid));
  try {
    await waitUp(server);
    const out = join(root, ".4dd", "shots", "android-raw", id);
    rmSync(out, { recursive: true, force: true });
    const env = { ...process.env, PATH: `${join(sdk, "platform-tools")}:${process.env.PATH}` };
    const run = () => {
      const r = spawnSync(maestro, ["test", file, "--test-output-dir", out], { cwd: root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
      process.stdout.write(r.stdout ?? "");
      process.stderr.write(r.stderr ?? "");
      return r;
    };
    let r = run();
    // 긴 실행 중에 Maestro의 기기 쪽 드라이버가 제때 뜨지 않을 때가 있다 (앱과 상관없는 도구 문제). 그 플로우만 한 번 다시 돌린다 (조각 3 실제 실행)
    if (r.status !== 0 && /did not start up in time|DriverStartupException/.test(`${r.stdout}${r.stderr}`)) {
      console.error(`[e2e-android] ${id}: Maestro 드라이버가 뜨지 않아 한 번 다시 돌립니다`);
      rmSync(out, { recursive: true, force: true });
      r = run();
    }
    if (r.status !== 0) failed++;
    const shot = pngs(out).find((p) => basename(p) === `${id}.png`) ?? pngs(out).at(-1);
    if (shot) copyFileSync(shot, join(shots, `${id}.png`));
  } finally {
    stopServer(server.pid);
    current = null;
    rmSync(pidFile, { force: true });
  }
}
process.exit(failed ? 1 : 0);
