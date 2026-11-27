/** 아이디 규칙(R9): ASCII 영문자·숫자로만 된 4~20자. */
export const USERNAME_PATTERN = /^[A-Za-z0-9]{4,20}$/;

/** 아이디가 규칙에 맞는지 본다. 앞뒤 빈칸을 잘라 내지 않고 낸 값 그대로 판단한다. */
export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

/** 비밀번호 최소 글자 수(R6). 글자 수는 코드 포인트로 센다. */
export const MIN_PASSWORD_LENGTH = 8;

export type PasswordRule = "min_length" | "letter_and_digit" | "not_username";

/** 비밀번호가 못 채운 규칙을 설계 순서대로 돌려준다. 다 채우면 빈 배열. */
export function failedPasswordRules(username: string, password: string): PasswordRule[] {
  const failed: PasswordRule[] = [];
  if ([...password].length < MIN_PASSWORD_LENGTH) failed.push("min_length");
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) failed.push("letter_and_digit");
  if (password.toLowerCase() === username.toLowerCase()) failed.push("not_username");
  return failed;
}
