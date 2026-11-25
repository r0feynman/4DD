import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  lockRemainingSec,
  recordFailure,
  recordSuccess,
  releaseExpiredLock,
  type LockoutState,
} from "./lockout.js";

export interface UserSeed {
  username: string;
  password: string;
}

export interface Clock {
  now(): number;
}

export interface BuildAppOptions {
  users?: UserSeed[];
  clock?: Clock;
}

interface Account extends LockoutState {
  passwordHash: string;
}

const KEY_LENGTH = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const accounts = new Map<string, Account>();
  for (const { username, password } of options.users ?? []) {
    accounts.set(username, {
      passwordHash: hashPassword(password),
      failCount: 0,
      lockedUntil: null,
    });
  }

  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const app = Fastify();

  app.post<{ Body: { username: string; password: string } }>(
    "/api/login",
    async (request, reply) => {
      const { username, password } = request.body;
      const account = accounts.get(username);

      if (!account) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const now = clock.now();
      const sendLocked = (retryAfterSec: number) =>
        reply.code(423).send({ error: "locked", retryAfterSec });

      releaseExpiredLock(account, now);
      const lockedFor = lockRemainingSec(account, now);
      if (lockedFor !== null) {
        return sendLocked(lockedFor);
      }

      if (!verifyPassword(password, account.passwordHash)) {
        recordFailure(account, now);
        const lockedNow = lockRemainingSec(account, now);
        if (lockedNow !== null) {
          return sendLocked(lockedNow);
        }
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      recordSuccess(account);
      return reply.code(200).send({ ok: true });
    },
  );

  return app;
}
