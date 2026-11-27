# 설계 스펙: 회원 가입 (N13)

login 설계(`specs/login/design.md`)의 구조를 그대로 따른다. 앱은 `buildApp(options)` 하나로 만들고, 저장소는 메모리, 비밀번호 해시는 `node:crypto`의 `scrypt`를 쓴다. 가입은 바깥 서비스를 부르지 않는다(메일·문자 인증은 범위 밖). 시간에 따른 규칙도 없어서 `options.clock`은 쓰지 않는다.

## 구조

| 파일 | 하는 일 | 내보내는 것 |
|---|---|---|
| `src/accounts.ts` (새 파일) | 회원 저장소와 비밀번호 해시. 지금 `src/app.ts` 안에 있는 `Account`, `hashPassword`, `verifyPassword`, `Map<username, Account>`를 여기로 옮긴다. 같은 일을 하는 코드를 새로 만들지 않고 옮기기만 한다. | `interface Account`, `interface AccountStore`, `function createAccountStore(seeds?: UserSeed[]): AccountStore`, `function hashPassword(password: string): string`, `function verifyPassword(password: string, stored: string): boolean` |
| `src/signup-rules.ts` (새 파일) | 아이디 규칙과 비밀번호 규칙 판단. 순수 함수로 두어 단위 테스트로 끝값을 확인한다. | `const USERNAME_PATTERN = /^[A-Za-z0-9]{4,20}$/`, `const MIN_PASSWORD_LENGTH = 8`, `type PasswordRule = "min_length" \| "letter_and_digit" \| "not_username"`, `function isValidUsername(username: string): boolean`, `function failedPasswordRules(username: string, password: string): PasswordRule[]` |
| `src/app.ts` (바꿈) | `POST /api/signup` 라우트를 더하고, 로그인 라우트가 `AccountStore`를 쓰도록 바꾼다. | `UserSeed`, `Clock`, `BuildAppOptions`, `buildApp` (그대로). `BuildAppOptions`에 `accounts?: AccountStore`를 더한다. |
| `src/lockout.ts` | 바꾸지 않는다. | 그대로 |

### `AccountStore`
```ts
interface AccountStore {
  get(username: string): Account | undefined;       // 아이디를 그대로(대소문자 가림) 찾는다. 로그인이 쓴다.
  has(username: string): boolean;                   // 아이디를 그대로 찾는다. 테스트가 "회원이 있다/없다"를 확인할 때 쓴다.
  isTaken(username: string): boolean;               // 대소문자를 가리지 않고 겹치는지 본다 (R5).
  create(username: string, password: string): Account; // 비밀번호를 해시하고 failCount 0, lockedUntil null로 넣는다.
}
```
- `createAccountStore(seeds)`는 `seeds`의 각 회원을 `create`로 넣는다. 지금 `buildApp`이 `options.users`를 넣는 방식과 결과가 같다.

### 시험 경계
- `buildApp({ accounts })`로 저장소를 바꿔 끼울 수 있다. 인수 테스트는 `createAccountStore([{ username: "kim", password: "kimpass12" }])`로 배경을 만들고, 그 저장소를 `buildApp`에 넘긴 뒤 `accounts.has("lee")`로 "아이디 lee인 회원이 있다/없다"를 확인한다.
- `accounts`를 주지 않으면 `buildApp`이 `createAccountStore(options.users)`로 만든다. `accounts`와 `users`를 같이 주면 `users`를 그 저장소에 더 넣는다. 기존 테스트(`buildApp({ users })`)는 고치지 않아도 된다.
- 바깥 서비스는 없다. 가짜로 바꿀 것도 없다.

## API

| 메서드 | 경로 | 요청 본문 | 응답 |
|---|---|---|---|
| POST | `/api/signup` | `{ "username": string, "password": string }` | 아래 표 |

판단은 위에서부터 차례로 하고, 처음 걸린 곳에서 답한다.

| 순서 | 조건 | 상태 | 본문 | 다루는 것 |
|---|---|---|---|---|
| 1 | 본문이 객체가 아니거나, `username`·`password`가 없거나 문자열이 아님 | 400 | `{ "error": "bad_request" }` | 제약(아이디·비밀번호만 받음) |
| 2 | `isValidUsername(username)`이 거짓 (빈 문자열 포함) | 400 | `{ "error": "invalid_username" }` | R9, R8, S12 |
| 3 | `accounts.isTaken(username)`이 참 | 409 | `{ "error": "username_taken" }` | R5, R8, S5, S11, S10 |
| 4 | `failedPasswordRules(username, password)`가 비어 있지 않음 | 400 | `{ "error": "weak_password", "rules": PasswordRule[] }` | R6, R8, S6, S9 |
| 5 | 위에 다 걸리지 않음 → `accounts.create(username, password)` | 201 | `{ "username": string }` | R4, S4, S13, S14 |

- 본문에 `username`, `password` 말고 다른 필드가 있으면 무시하고 저장하지 않는다(제약: 아이디와 비밀번호만 받는다).
- 가입 성공 응답에는 세션이나 토큰을 넣지 않는다. 로그인 상태를 만들지 않는다(R7). 로그인은 기존 `POST /api/login`으로 따로 한다.
- 로그인 API(`POST /api/login`)의 경로, 요청, 응답은 바꾸지 않는다.

## 데이터 모델
login과 같은 메모리 안의 `Map<username, Account>` 하나를 `AccountStore`가 감싼다. 키는 가입할 때 낸 아이디를 대소문자 그대로 쓴다.

| 필드 | 타입 | 뜻 | 가입 직후 값 |
|---|---|---|---|
| `passwordHash` | string | `scrypt` 해시와 소금 (`소금hex:해시hex`, 기존 형식 그대로) | `hashPassword(password)` |
| `failCount` | number | 연속 실패 수 | `0` |
| `lockedUntil` | number \| null | 잠금이 풀리는 시각 | `null` |

- 평문 비밀번호는 어디에도 저장하지 않는다(제약).
- 대소문자를 가리지 않는 겹침 검사(`isTaken`)는 `Map`의 키를 `toLowerCase()`로 비교한다. 회원 수가 메모리 안에 있는 만큼이라 따로 색인을 두지 않는다. 대신 `create`할 때 소문자 키 `Set`을 함께 두어도 된다(구현이 고름, 결과는 같아야 함).

## 규칙

### 아이디 (R9)
- `/^[A-Za-z0-9]{4,20}$/`에 맞아야 한다. 영문자는 ASCII `A–Z`, `a–z`만, 숫자는 `0–9`만 친다. 한글, 밑줄, 빈칸, 빈 문자열은 거절한다(S12). 4자와 20자는 받는다(S13).
- 아이디 앞뒤 빈칸을 잘라 내지 않는다. 낸 값 그대로 판단한다.

### 겹침 (R5)
- `username.toLowerCase()`가 이미 있는 아이디의 `toLowerCase()`와 같으면 겹친다. `Kim`, `KIM`은 `kim`과 겹친다(S11).
- 아이디 규칙이 ASCII 영문자·숫자뿐이라 `toLowerCase()`로 충분하다.

### 비밀번호 (R6)
`failedPasswordRules`는 아래 셋을 모두 검사하고, 못 채운 것만 이 순서대로 배열에 담는다. 하나만 못 채우면 그 하나만 담는다(S6 "정확히").

| 순서 | 이름 | 채우는 조건 |
|---|---|---|
| 1 | `min_length` | 글자 수(`[...password].length`)가 8 이상. 7자는 못 채우고 8자는 채운다(S6 `abcde12`, S14 `abcdefg1`). |
| 2 | `letter_and_digit` | `/[A-Za-z]/`와 `/[0-9]/`에 모두 맞는다. |
| 3 | `not_username` | `password.toLowerCase() !== username.toLowerCase()` (S6 `lee12345`/`LEE12345`). |

### 판단 순서와 원자성 (R8)
- 거절(400, 409)될 때는 `create`를 부르지 않는다. 그래서 거절된 가입은 회원을 만들지 않고(S9, S12), 기존 회원의 비밀번호·실패 수도 바꾸지 않는다(S10).
- 겹침 검사(`isTaken`)와 `create`는 사이에 `await` 없이 이어서 부른다. 해시(`scryptSync`)도 동기라서, 같은 아이디로 동시에 두 요청이 와도 하나만 만들어진다.

### 로그인과의 관계 (R7, 제약)
- 새 회원은 `failCount: 0`, `lockedUntil: null`로 시작하므로 login R2·R3 규칙을 처음부터 그대로 따른다.
- 로그인은 기존처럼 `accounts.get(username)`으로 아이디를 대소문자 그대로 찾는다. 가입 단계에서 대소문자만 다른 아이디를 막으므로 한 사람의 실패 수가 다른 계정에 섞이지 않는다.
- 가입한 아이디·비밀번호로 로그인하면 `200`(S7), 다른 비밀번호면 `401`(S8). 거절된 가입의 아이디로 로그인하면 회원이 없으므로 `401`(S9). 409로 거절된 `kim`은 원래 비밀번호로만 `200`(S10).

## 기존 기능에 주는 영향
- `src/app.ts`
  - `Account`, `hashPassword`, `verifyPassword`, `KEY_LENGTH`와 `Map<string, Account>`를 만드는 코드를 `src/accounts.ts`로 옮긴다. 해시 형식과 비교 방식은 그대로다.
  - `BuildAppOptions`에 `accounts?: AccountStore`를 더한다. `users`, `clock`은 그대로 둔다.
  - 로그인 라우트의 `accounts.get(username)`은 `Map` 대신 `AccountStore.get`을 부른다. 응답과 잠금 판단은 바꾸지 않는다.
  - `POST /api/signup` 라우트를 더한다.
- `src/lockout.ts`: 바꾸지 않는다.
- 기존 테스트 `tests/acceptance/S1~S3.test.ts`, `tests/unit/app.test.ts`, `tests/unit/lockout.test.ts`는 고치지 않고 그대로 통과해야 한다.

## 요구사항·시나리오 추적

| ID | 다루는 곳 |
|---|---|
| R4 | API 순서 5, `AccountStore.create` |
| R5 | API 순서 3, 규칙 › 겹침, `AccountStore.isTaken` |
| R6 | API 순서 4, 규칙 › 비밀번호, `failedPasswordRules` |
| R7 | API(토큰 없음), 규칙 › 로그인과의 관계, 데이터 모델(가입 직후 값) |
| R8 | 규칙 › 판단 순서와 원자성 |
| R9 | API 순서 2, 규칙 › 아이디, `isValidUsername` |
| S4 | API 순서 5, 시험 경계(`accounts.has("lee")`) |
| S5 | API 순서 3 |
| S6 | API 순서 4, 규칙 › 비밀번호(순서와 "정확히") |
| S7, S8 | 규칙 › 로그인과의 관계 |
| S9 | 규칙 › 판단 순서와 원자성, 시험 경계(`accounts.has`) |
| S10 | 규칙 › 판단 순서와 원자성, 로그인과의 관계 |
| S11 | 규칙 › 겹침, 시험 경계(`accounts.has("Kim")`이 거짓) |
| S12 | API 순서 2, 규칙 › 아이디, 시험 경계 |
| S13 | 규칙 › 아이디(4자·20자·대문자) |
| S14 | 규칙 › 비밀번호(8자 끝값) |
