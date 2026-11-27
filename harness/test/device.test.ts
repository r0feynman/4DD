// 가상 기기 (조각 3): 진짜 에뮬레이터 없이 가짜 adb·emulator 스크립트로 띄우기, 이미 떠 있음, 끄기, 부팅 시간 초과를 본다.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootedSerial, DeviceError, deviceDown, deviceUp, type DeviceSettings } from "../src/device.ts";
import { readEvents } from "../src/ledger.ts";

/** 가짜 SDK: emulator가 state 폴더에 booted를 만들고, adb는 그 파일로 대답한다 */
function fakeSdk(opts: { boots: boolean; avd?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "4dd-sdk-"));
  const state = join(dir, "state");
  mkdirSync(state);
  mkdirSync(join(dir, "platform-tools"));
  mkdirSync(join(dir, "emulator"));
  const adb = `#!/bin/sh
S="${state}"
case "$*" in
  devices) echo "List of devices attached"; [ -f "$S/booted" ] && printf 'emulator-5554\\tdevice\\n'; exit 0 ;;
  *"emu avd name"*) echo "${opts.avd ?? "4dd-api36"}"; echo OK; exit 0 ;;
  *"getprop sys.boot_completed"*) [ -f "$S/booted" ] && echo 1; exit 0 ;;
  *"emu kill"*) rm -f "$S/booted"; echo OK; exit 0 ;;
esac
exit 0
`;
  const emu = opts.boots ? `#!/bin/sh\nsleep 0.2\ntouch "${state}/booted"\n` : "#!/bin/sh\nexit 0\n";
  writeFileSync(join(dir, "platform-tools", "adb"), adb);
  writeFileSync(join(dir, "emulator", "emulator"), emu);
  chmodSync(join(dir, "platform-tools", "adb"), 0o755);
  chmodSync(join(dir, "emulator", "emulator"), 0o755);
  return { sdk: dir, state };
}

const project = () => mkdtempSync(join(tmpdir(), "4dd-dev-"));
const devices = (root: string) => readEvents(root).events.filter((e) => e.type === "device");

describe("4dd device", () => {
  it("띄우고 부팅을 기다린 뒤, 이미 떠 있으면 그대로 쓰고, 끈다", () => {
    const { sdk, state } = fakeSdk({ boots: true });
    const d: DeviceSettings = { avd: "4dd-api36", sdk, bootTimeoutSec: 10 };
    const root = project();
    expect(bootedSerial(d)).toBeNull();
    const up = deviceUp(root, d, "0.3.0", { pollMs: 100, sg: false });
    expect(up).toMatchObject({ serial: "emulator-5554", already: false });
    expect(existsSync(join(state, "booted"))).toBe(true);
    expect(deviceUp(root, d, "0.3.0", { pollMs: 100, sg: false })).toMatchObject({ already: true });
    expect(deviceDown(root, d, "0.3.0", 50)).toBe(1);
    expect(bootedSerial(d)).toBeNull();
    expect(devices(root).map((e) => (e.type === "device" ? `${e.action}:${e.result}` : ""))).toEqual(["up:ok", "up:already", "down:ok"]);
  });

  it("다른 AVD로 떠 있는 기기는 이 기기로 치지 않는다", () => {
    const { sdk, state } = fakeSdk({ boots: true, avd: "other-avd" });
    writeFileSync(join(state, "booted"), "");
    expect(bootedSerial({ avd: "4dd-api36", sdk, bootTimeoutSec: 10 })).toBeNull();
  });

  it("정해진 시간 안에 부팅하지 않으면 멈추고 원장에 실패를 남긴다", () => {
    const { sdk } = fakeSdk({ boots: false });
    const root = project();
    expect(() => deviceUp(root, { avd: "4dd-api36", sdk, bootTimeoutSec: 1 }, "0.3.0", { pollMs: 200, sg: false })).toThrow(DeviceError);
    expect(devices(root).at(-1)).toMatchObject({ action: "up", result: "fail" });
  });
});
