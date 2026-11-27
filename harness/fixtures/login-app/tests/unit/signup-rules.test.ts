import { describe, it, expect } from "vitest";
import {
  USERNAME_PATTERN,
  MIN_PASSWORD_LENGTH,
  isValidUsername,
  failedPasswordRules,
} from "../../src/signup-rules.js";

describe("USERNAME_PATTERN", () => {
  it("설계대로 /^[A-Za-z0-9]{4,20}$/ 이다", () => {
    expect(USERNAME_PATTERN.source).toBe("^[A-Za-z0-9]{4,20}$");
    expect(USERNAME_PATTERN.flags).toBe("");
  });
});

describe("isValidUsername", () => {
  it.each([
    ["park", "4자"],
    ["abcdefghij0123456789", "20자"],
    ["Park2025", "영문 대문자와 숫자"],
    ["ABCD", "대문자만"],
    ["1234", "숫자만"],
  ])('"%s"(%s)는 받는다', (username) => {
    expect(isValidUsername(username)).toBe(true);
  });

  it.each([
    ["", "빈 문자열"],
    ["abc", "3자"],
    ["abcdefghij01234567890", "21자"],
    ["김철수님", "한글"],
    ["park_01", "밑줄"],
    ["park 01", "가운데 빈칸"],
    [" park", "앞 빈칸(잘라 내지 않음)"],
    ["park ", "뒤 빈칸(잘라 내지 않음)"],
    ["park-01", "하이픈"],
    ["parké", "ASCII가 아닌 영문자"],
    ["park１２", "전각 숫자"],
    ["park\n", "끝 줄바꿈"],
  ])('"%s"(%s)는 거절한다', (username) => {
    expect(isValidUsername(username)).toBe(false);
  });
});

describe("failedPasswordRules › min_length", () => {
  it("MIN_PASSWORD_LENGTH는 8이다", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });

  it('7자 "abcde12"는 min_length 하나만 못 채운다', () => {
    expect(failedPasswordRules("lee01", "abcde12")).toEqual(["min_length"]);
  });

  it('8자 "abcdefg1"는 모든 규칙을 채운다', () => {
    expect(failedPasswordRules("lee01", "abcdefg1")).toEqual([]);
  });

  it("글자 수는 UTF-16 단위가 아니라 코드 포인트(`[...password].length`)로 센다", () => {
    // "a1" + 이모지 6개 = 코드 포인트 8개 → 채운다
    expect(failedPasswordRules("lee01", "a1😀😀😀😀😀😀")).toEqual([]);
    // "a1" + 이모지 5개 = 코드 포인트 7개 (UTF-16 길이는 12) → 못 채운다
    expect(failedPasswordRules("lee01", "a1😀😀😀😀😀")).toEqual(["min_length"]);
  });
});

describe("failedPasswordRules › letter_and_digit", () => {
  it.each([
    ["abcdefgh", "영문자만"],
    ["12345678", "숫자만"],
    ["!@#$%^&*", "기호만"],
    ["가나다라마바사1", "한글과 숫자(ASCII 영문자 없음)"],
    ["abcdefg１", "영문자와 전각 숫자(ASCII 숫자 없음)"],
  ])('"%s"(%s)는 letter_and_digit 하나만 못 채운다', (password) => {
    expect(failedPasswordRules("lee01", password)).toEqual(["letter_and_digit"]);
  });

  it.each([
    ["abcdefg1", "소문자와 숫자"],
    ["ABCDEFG1", "대문자와 숫자"],
    ["1234567a", "숫자 뒤에 영문자 하나"],
    ["ab!@#$%1", "기호가 섞여도 영문자·숫자가 하나씩 있음"],
  ])('"%s"(%s)는 letter_and_digit을 채운다', (password) => {
    expect(failedPasswordRules("lee01", password)).toEqual([]);
  });
});

describe("failedPasswordRules › not_username", () => {
  it('아이디와 같은 비밀번호 "lee12345"는 not_username 하나만 못 채운다', () => {
    expect(failedPasswordRules("lee12345", "lee12345")).toEqual(["not_username"]);
  });

  it('대소문자만 다른 "LEE12345"도 아이디 "lee12345"와 같다고 본다', () => {
    expect(failedPasswordRules("lee12345", "LEE12345")).toEqual(["not_username"]);
    expect(failedPasswordRules("LEE12345", "lee12345")).toEqual(["not_username"]);
  });

  it("아이디를 포함하기만 한 비밀번호는 같지 않으므로 채운다", () => {
    expect(failedPasswordRules("lee12345", "lee123456")).toEqual([]);
  });
});

describe("failedPasswordRules › 여러 규칙", () => {
  it('"abc"는 min_length, letter_and_digit 순서로 둘 다 못 채운다', () => {
    expect(failedPasswordRules("lee01", "abc")).toEqual(["min_length", "letter_and_digit"]);
  });

  it("셋 다 못 채우면 min_length, letter_and_digit, not_username 순서로 담는다", () => {
    expect(failedPasswordRules("abcd", "ABCD")).toEqual([
      "min_length",
      "letter_and_digit",
      "not_username",
    ]);
  });

  it("min_length와 not_username만 못 채우면 그 둘만 순서대로 담는다", () => {
    expect(failedPasswordRules("abc1", "ABC1")).toEqual(["min_length", "not_username"]);
  });

  it("letter_and_digit과 not_username만 못 채우면 그 둘만 순서대로 담는다", () => {
    expect(failedPasswordRules("abcdefgh", "ABCDEFGH")).toEqual([
      "letter_and_digit",
      "not_username",
    ]);
  });
});
