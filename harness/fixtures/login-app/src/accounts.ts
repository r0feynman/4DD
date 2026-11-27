import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { UserSeed } from "./app.js";
import type { LockoutState } from "./lockout.js";

export interface Account extends LockoutState {
  passwordHash: string;
}

export interface AccountStore {
  get(username: string): Account | undefined;
  has(username: string): boolean;
  /** 대소문자를 가리지 않고 이미 있는 아이디와 겹치는지 본다 (R5). */
  isTaken(username: string): boolean;
  create(username: string, password: string): Account;
}

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function createAccountStore(seeds: UserSeed[] = []): AccountStore {
  const accounts = new Map<string, Account>();

  const store: AccountStore = {
    get: (username) => accounts.get(username),
    has: (username) => accounts.has(username),
    isTaken(username) {
      const lower = username.toLowerCase();
      for (const existing of accounts.keys()) {
        if (existing.toLowerCase() === lower) return true;
      }
      return false;
    },
    create(username, password) {
      const account: Account = {
        passwordHash: hashPassword(password),
        failCount: 0,
        lockedUntil: null,
      };
      accounts.set(username, account);
      return account;
    },
  };

  for (const { username, password } of seeds) {
    store.create(username, password);
  }

  return store;
}
