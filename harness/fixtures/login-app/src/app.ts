import Fastify, { type FastifyInstance } from "fastify";
import { createAccountStore, verifyPassword, type AccountStore } from "./accounts.js";
import {
  lockRemainingSec,
  recordFailure,
  recordSuccess,
  releaseExpiredLock,
} from "./lockout.js";
import { failedPasswordRules, isValidUsername } from "./signup-rules.js";

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
  accounts?: AccountStore;
}

/** 본문이 문자열 `username`·`password`를 가진 객체인지 본다. */
function isCredentials(body: unknown): body is UserSeed {
  if (typeof body !== "object" || body === null) return false;
  const { username, password } = body as Record<string, unknown>;
  return typeof username === "string" && typeof password === "string";
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const accounts = options.accounts ?? createAccountStore();
  for (const { username, password } of options.users ?? []) {
    accounts.create(username, password);
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

  app.post("/api/signup", async (request, reply) => {
    if (!isCredentials(request.body)) {
      return reply.code(400).send({ error: "bad_request" });
    }

    // 아이디와 비밀번호만 꺼내고 다른 필드는 무시한다.
    const { username, password } = request.body;

    if (!isValidUsername(username)) {
      return reply.code(400).send({ error: "invalid_username" });
    }

    // 겹침 검사와 create 사이에 await를 두지 않는다 (R8).
    if (accounts.isTaken(username)) {
      return reply.code(409).send({ error: "username_taken" });
    }

    const rules = failedPasswordRules(username, password);
    if (rules.length > 0) {
      return reply.code(400).send({ error: "weak_password", rules });
    }

    accounts.create(username, password);
    return reply.code(201).send({ username });
  });

  return app;
}
