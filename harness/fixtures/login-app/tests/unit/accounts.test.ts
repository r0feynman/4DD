import { describe, it, expect } from "vitest";
import { createAccountStore } from "../../src/accounts.js";

describe("createAccountStore", () => {
  it("seeds로 넣은 회원을 아이디 그대로 찾고, failCount 0·lockedUntil null로 시작한다", () => {
    // R9: 예시 아이디는 아이디 규칙(영문자·숫자 4~20자)에 맞는 값을 쓴다.
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);

    expect(accounts.has("kim01")).toBe(true);
    expect(accounts.has("Kim01")).toBe(false);
    expect(accounts.has("lee01")).toBe(false);

    const kim = accounts.get("kim01");
    expect(kim).toBeDefined();
    expect(kim!.failCount).toBe(0);
    expect(kim!.lockedUntil).toBeNull();
    expect(kim!.passwordHash).not.toContain("kimpass12");
    expect(kim!.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it("isTaken은 대소문자를 가리지 않고 이미 있는 아이디와 겹치는지 본다 (R5)", () => {
    const accounts = createAccountStore([{ username: "kim01", password: "kimpass12" }]);

    expect(accounts.isTaken("kim01")).toBe(true);
    expect(accounts.isTaken("Kim01")).toBe(true);
    expect(accounts.isTaken("KIM01")).toBe(true);
    expect(accounts.isTaken("lee01")).toBe(false);
    expect(accounts.isTaken("kim011")).toBe(false);

    // isTaken은 확인만 하고 회원을 만들지 않는다 (R8)
    expect(accounts.has("Kim01")).toBe(false);
  });

  it("create로 넣은 아이디도 대소문자를 가리지 않고 isTaken에 잡힌다", () => {
    const accounts = createAccountStore();
    expect(accounts.isTaken("lee01")).toBe(false);

    accounts.create("Lee01", "leepass12");

    expect(accounts.isTaken("lee01")).toBe(true);
    expect(accounts.isTaken("LEE01")).toBe(true);
  });
});
