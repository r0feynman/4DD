// 가상 기기 (조각 3): Android 에뮬레이터를 창 없이 띄우고, 부팅을 기다리고, 끈다.
//
//   4dd device up      이미 떠 있으면 그대로 쓰고, 아니면 띄워 부팅(sys.boot_completed=1)까지 기다림
//   4dd device down    떠 있는 기기를 끔
//   4dd device status  떠 있는 기기
//
// 지휘 프로그램은 Stage 2를 시작할 때 한 번 띄우고 끝날 때 끈다 (조각 3 「기기와 서버」, 기기 부팅 약 50초).
// /dev/kvm을 이 프로세스가 쓸 수 없으면(kvm 그룹에 막 들어가 아직 새 로그인 전) `sg kvm -c`로 띄운다.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { appendEvent, DIR } from "./ledger.ts";

export interface DeviceSettings {
  avd: string;
  sdk: string;
  bootTimeoutSec: number;
}

export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceError";
  }
}

export const DEVICE_LOG = `${DIR}/device.log`;

export function deviceSettings(config?: Pick<Config, "device">, env: NodeJS.ProcessEnv = process.env): DeviceSettings {
  return {
    avd: config?.device?.avd ?? "4dd-api36",
    sdk: config?.device?.sdk ?? env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? join(homedir(), "Android", "Sdk"),
    bootTimeoutSec: config?.device?.boot_timeout_sec ?? 300,
  };
}

function adb(d: DeviceSettings, args: string[], timeout = 15_000): string {
  const r = spawnSync(join(d.sdk, "platform-tools", "adb"), args, { encoding: "utf8", timeout });
  return r.status === 0 ? r.stdout : "";
}

/** 붙어 있는 에뮬레이터 (adb devices에서 state가 device인 emulator-*) */
function emulators(d: DeviceSettings): string[] {
  return adb(d, ["devices"])
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
}

/** 이 AVD로 떠서 부팅을 마친 기기의 시리얼. 없으면 null */
export function bootedSerial(d: DeviceSettings): string | null {
  for (const serial of emulators(d)) {
    const name = adb(d, ["-s", serial, "emu", "avd", "name"]).split("\n")[0]?.trim();
    if (name && name !== d.avd) continue;
    if (adb(d, ["-s", serial, "shell", "getprop", "sys.boot_completed"]).trim() === "1") return serial;
  }
  return null;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function kvmWritable(): boolean {
  if (!existsSync("/dev/kvm")) return true; // KVM이 없는 곳(다른 OS)에서는 에뮬레이터가 알아서 고름
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const shq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export interface UpResult {
  serial: string;
  bootSeconds: number;
  already: boolean;
}

export interface UpOptions {
  pollMs?: number;
  /** sg kvm으로 띄울지. 기본은 /dev/kvm을 이 프로세스가 쓸 수 없을 때만 (테스트는 false) */
  sg?: boolean;
}

export function deviceUp(root: string, d: DeviceSettings, harness = "0.0.0", opts: UpOptions = {}): UpResult {
  const pollMs = opts.pollMs ?? 3000;
  const useSg = opts.sg ?? !kvmWritable();
  const have = bootedSerial(d);
  if (have) {
    appendEvent(root, harness, { type: "device", action: "up", avd: d.avd, result: "already" });
    return { serial: have, bootSeconds: 0, already: true };
  }
  const emulator = join(d.sdk, "emulator", "emulator");
  if (!existsSync(emulator)) throw new DeviceError(`에뮬레이터가 없습니다: ${emulator} (sdkmanager로 emulator를 설치하세요)`);
  const args = ["-avd", d.avd, "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect"];
  mkdirSync(join(root, DIR), { recursive: true });
  const log = openSync(join(root, DEVICE_LOG), "a");
  const child = useSg
    ? spawn("sg", ["kvm", "-c", [emulator, ...args].map(shq).join(" ")], { detached: true, stdio: ["ignore", log, log] })
    : spawn(emulator, args, { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const start = Date.now();
  while (Date.now() - start < d.bootTimeoutSec * 1000) {
    sleepMs(pollMs);
    const serial = bootedSerial(d);
    if (serial) {
      const bootSeconds = Math.round((Date.now() - start) / 1000);
      appendEvent(root, harness, { type: "device", action: "up", avd: d.avd, result: "ok", boot_seconds: bootSeconds });
      return { serial, bootSeconds, already: false };
    }
  }
  appendEvent(root, harness, { type: "device", action: "up", avd: d.avd, result: "fail" });
  throw new DeviceError(`가상 기기 ${d.avd}가 ${d.bootTimeoutSec}초 안에 부팅하지 않았습니다 (${DEVICE_LOG})`);
}

/** 떠 있는 에뮬레이터를 끈다. 끈 기기 수를 돌려준다 */
export function deviceDown(root: string, d: DeviceSettings, harness = "0.0.0", pollMs = 1000): number {
  const serials = emulators(d);
  for (const serial of serials) adb(d, ["-s", serial, "emu", "kill"]);
  for (let i = 0; i < 30 && emulators(d).length; i++) sleepMs(pollMs);
  if (serials.length) appendEvent(root, harness, { type: "device", action: "down", avd: d.avd, result: emulators(d).length ? "fail" : "ok" });
  return serials.length;
}
