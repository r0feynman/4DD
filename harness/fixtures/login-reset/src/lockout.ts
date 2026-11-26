export const MAX_FAILURES = 5;
export const LOCK_DURATION_MS = 10 * 60 * 1000;

export interface LockoutState {
  failCount: number;
  lockedUntil: number | null;
}

/** 비밀번호가 틀린 시도를 하나 센다. 연속 실패가 MAX_FAILURES에 닿으면 잠근다. */
export function recordFailure(account: LockoutState, now: number): void {
  account.failCount += 1;
  if (account.failCount >= MAX_FAILURES) {
    account.lockedUntil = now + LOCK_DURATION_MS;
  }
}

/** 로그인에 성공했으니 연속 실패 수를 0으로 되돌린다. */
export function recordSuccess(account: LockoutState): void {
  account.failCount = 0;
}

/** 잠금 시간이 지났으면 잠금을 풀고 연속 실패 수를 0으로 되돌린다. */
export function releaseExpiredLock(account: LockoutState, now: number): void {
  if (account.lockedUntil !== null && account.lockedUntil <= now) {
    account.lockedUntil = null;
    account.failCount = 0;
  }
}

/** 잠겨 있으면 풀리기까지 남은 시간(초, 올림)을, 잠기지 않았으면 null을 돌려준다. */
export function lockRemainingSec(account: LockoutState, now: number): number | null {
  if (account.lockedUntil === null || account.lockedUntil <= now) {
    return null;
  }
  return Math.ceil((account.lockedUntil - now) / 1000);
}
