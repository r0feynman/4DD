# 설계 스펙: 로그인 (N13)

## 아키텍처
- `src/app.ts`가 `buildApp(options)`를 내보낸다. Fastify 앱을 만들어 돌려주고, 서버를 띄우지는 않는다.
- `options.users`: 처음 가입된 사용자 목록 `[{ username, password }]`. 앱을 만들 때 비밀번호를 해시해서 저장한다.
- `options.clock`: `{ now(): number }` (밀리초). 기본값은 `Date.now`. 테스트는 시계를 바꿔 끼워 시간을 앞당긴다.
- 잠금 규칙은 `src/lockout.ts`에 두고, 라우트는 `src/app.ts`에 둔다.

## API
| 메서드 | 경로 | 요청 본문 | 응답 |
|---|---|---|---|
| POST | `/api/login` | `{ "username": string, "password": string }` | 성공 `200 { "ok": true }` · 아이디나 비밀번호가 틀림 `401 { "error": "invalid_credentials" }` · 잠김 `423 { "error": "locked", "retryAfterSec": number }` |

- 요청 본문에 `username`이나 `password`가 없으면 `400 { "error": "bad_request" }`.
- 없는 아이디도 `401 invalid_credentials`로 답한다. 아이디가 있는지 알려 주지 않기 위해서다.
- 5번째로 틀린 요청부터 바로 `423`을 돌려준다.
- `retryAfterSec`는 잠금이 풀리기까지 남은 시간을 초 단위로 올림한 값이다.

## 데이터 모델
메모리 안의 `Map<username, Account>` 하나.

| 필드 | 타입 | 뜻 |
|---|---|---|
| `passwordHash` | string | `node:crypto`의 `scrypt`로 만든 해시와 소금 |
| `failCount` | number | 연속 실패 수. 성공하면 0 |
| `lockedUntil` | number \| null | 잠금이 풀리는 시각 (밀리초). 잠기지 않았으면 `null` |

## 결정 사항
- 잠금 시간은 서버 시계로 계산한다. 클라이언트가 보낸 시각은 쓰지 않는다.
- 잠금이 풀리면 연속 실패 수도 0으로 돌아간다.
- 저장소는 메모리로 둔다. 이 기능의 범위가 로그인 규칙이고, 영속 저장은 다른 기능에서 다룬다.
