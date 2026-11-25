import { describe, expect, it } from "vitest";
import { countSource } from "../src/testscan.ts";

describe("테스트 수와 건너뛰기 표시 세기", () => {
  it("it, test, each를 센다", () => {
    const src = `
      describe("묶음", () => {
        it("하나", () => {});
        test("둘", () => {});
        it.each([1, 2])("셋 %i", () => {});
        test.concurrent("넷", async () => {});
      });`;
    expect(countSource(src)).toEqual({ tests: 4, skips: 0 });
  });

  it("건너뛰기 표시를 센다 (skip, todo, only, x 접두사)", () => {
    const src = `it.skip("a", () => {}); test.todo("b"); it.only("c", () => {}); xit("d", () => {}); describe.skip("e", () => {});`;
    expect(countSource(src).skips).toBe(5);
  });

  it("주석 안의 것과 다른 이름 안의 글자는 세지 않는다", () => {
    const src = `// it("주석", () => {})\n/* test("블록") */\nconst audit = (x) => x; submit(1); const url = "http://x.test(1)";\ntest("진짜", () => {});`;
    expect(countSource(src)).toEqual({ tests: 1, skips: 0 });
  });
});
