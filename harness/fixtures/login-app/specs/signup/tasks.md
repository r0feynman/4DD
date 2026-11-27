# 작업 목록: 회원 가입 (N14)

N21에서 위에서부터 하나씩 골라 진행하고, N29에서 체크합니다.

- [x] T4 기존 로그인 바꿈: 회원 저장소를 `src/accounts.ts`(`AccountStore`의 `get`·`has`·`create`, `createAccountStore`, 해시 함수 옮김)로 떼어 내고, `buildApp`에 `accounts` 옵션을 더해 로그인 라우트가 저장소로 아이디를 찾게 하기. 기존 S1~S3과 단위 테스트는 그대로 통과 (R7)
- [x] T5 가입 API `POST /api/signup`: 본문 확인(`400 bad_request`), 아이디·비밀번호만 받아 `failCount 0`·`lockedUntil null`로 회원 만들기, `201 { username }`, 토큰 없음 (R4, R7)
- [x] T6 아이디 규칙: `src/signup-rules.ts`의 `isValidUsername`(영문자·숫자 4~20자), 맞지 않으면 회원을 만들지 않고 `400 invalid_username` (R9, R8)
- [x] T7 아이디 겹침: `AccountStore.isTaken`(대소문자 가리지 않음), 겹치면 회원을 만들거나 바꾸지 않고 `409 username_taken` (R5, R8)
- [x] T8 비밀번호 규칙: `failedPasswordRules`(min_length · letter_and_digit · not_username 순서), 못 채우면 회원을 만들지 않고 `400 weak_password`와 `rules` (R6, R8)
