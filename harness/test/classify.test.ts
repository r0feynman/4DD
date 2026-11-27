import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, TurnRequest, TurnResult } from "../src/adapters.ts";
import { classifyFailure, classifyPrompt, classifySchema, needsHuman } from "../src/classify.ts";
import { initProject } from "../src/init.ts";
import { loadNodes } from "../src/nodes.ts";

const nodes = loadNodes();
const root = join(mkdtempSync(join(tmpdir(), "4dd-classify-")), "proj");
initProject(root, { install: false });

function answering(structured: unknown, ok = true): Adapter & { reqs: TurnRequest[] } {
  const reqs: TurnRequest[] = [];
  return {
    agent: "claude",
    reqs,
    runTurn(req): TurnResult {
      reqs.push(req);
      return { ok, sessionId: req.sessionId, text: "", structured, minutes: 0.1, timedOut: false, tokens: { input: 5, output: 2 } };
    },
  };
}

const base = { root, nodes, nodeId: "N26", task: "T1", runId: "NR9", gateSummary: "N26 관문 실패\n- 명령이 통과해야 하는데 실패했습니다", session: "sess-T1" };

describe("실패 원인 분류", () => {
  it("관문이 정한 원인(test_flaky, env)은 그대로 쓴다", () => {
    const a = answering({ cause: "code_bug", evidence: "" });
    expect(classifyFailure({ ...base, machineCause: "test_flaky", adapter: a })).toMatchObject({ cause: "test_flaky", by: "harness", needsHuman: false });
    expect(classifyFailure({ ...base, machineCause: "env", adapter: a })).toMatchObject({ cause: "env", needsHuman: true });
    expect(a.reqs).toHaveLength(0);
  });

  it("그 노드의 단어만 주고, 읽기 전용 새 세션에서 고르게 한다 (작업 세션을 이어 쓰면 캐시가 식어 비쌈)", () => {
    const a = answering({ cause: "code_bug", evidence: "잠금 시각 계산이 틀림" });
    const r = classifyFailure({ ...base, adapter: a });
    expect(r).toMatchObject({ cause: "code_bug", by: "agent", needsHuman: false, evidence: "잠금 시각 계산이 틀림" });
    expect(a.reqs[0]).toMatchObject({ sessionId: null, readOnly: true });
    expect(a.reqs[0].prompt).toContain("새로 열었습니다");
    expect(a.reqs[0].prompt).toContain("## 이 작업\nT1 ");
    expect(a.reqs[0].jsonSchema).toEqual(classifySchema(["code_bug", "test_flaky", "spec_ambiguous", "spec_missing_state", "env"], true));
    expect(a.reqs[0].prompt).toContain("`spec_ambiguous`: 스펙이 모호해서");
  });

  it("앞 스테이지로 가는 원인을 고르면 사람이 승인해야 한다", () => {
    expect(classifyFailure({ ...base, adapter: answering({ cause: "spec_ambiguous", evidence: "10분의 기준 시점이 없음" }) })).toMatchObject({ cause: "spec_ambiguous", needsHuman: true });
  });

  it("그 노드에 없는 단어나 엉뚱한 답이면 기본 원인", () => {
    expect(classifyFailure({ ...base, adapter: answering({ cause: "ui_mismatch", evidence: "" }) })).toMatchObject({ cause: "code_bug", by: "harness" });
    expect(classifyFailure({ ...base, adapter: answering("모르겠음") })).toMatchObject({ cause: "code_bug", by: "harness" });
    expect(classifyFailure({ ...base, adapter: answering(undefined, false) })).toMatchObject({ cause: "code_bug", by: "harness" });
  });

  it("세션이 없거나 고를 단어가 하나뿐이면 묻지 않는다", () => {
    const a = answering({ cause: "env", evidence: "" });
    expect(classifyFailure({ ...base, session: null, adapter: a }).cause).toBe("code_bug");
    expect(a.reqs).toHaveLength(0);
  });

  it("사람에게 가는 원인 판단", () => {
    expect(needsHuman(nodes, "N27", "arch_wrong")).toBe(true);
    expect(needsHuman(nodes, "N27", "code_bug")).toBe(false);
    expect(needsHuman(nodes, "N28", "budget_exceeded")).toBe(true);
    expect(classifyPrompt("N28", "T1", ["code_bug", "env"], "요약")).toContain("확실하지 않으면 code_bug");
  });
});

describe("N26F 화면 비교의 고칠 곳 (조각 3)", () => {
  const f = { ...base, nodeId: "N26F", gateSummary: "N26F 관문 실패\n- android S15: 차이 79.64% (허용 5%) 넘음" };
  it("찍은 화면이 앱이 아니면 code_bug + flow로 골라 N22(플로우) 뒤 N26으로 간다", () => {
    const a = answering({ cause: "code_bug", evidence: "홈 화면이 찍힘. hideKeyboard가 앱을 닫음", fix_in: "flow" });
    const r = classifyFailure({ ...f, adapter: a });
    expect(r).toMatchObject({ cause: "code_bug", next: "N22", then: "N26", needsHuman: false });
    expect(r.evidence).toContain("플로우(인수 테스트)를 고침");
    expect(a.reqs[0].jsonSchema).toMatchObject({ required: ["cause", "evidence", "fix_in"] });
    expect(a.reqs[0].prompt).toContain("홈 화면");
  });

  it("앱을 고칠 code_bug나 다른 원인이면 정해진 경로 그대로", () => {
    expect(classifyFailure({ ...f, adapter: answering({ cause: "code_bug", evidence: "앱이 죽음", fix_in: "app" }) }).next).toBeUndefined();
    expect(classifyFailure({ ...f, adapter: answering({ cause: "ui_mismatch", evidence: "입력칸이 높음", fix_in: "flow" }) }).next).toBeUndefined();
  });

  it("고칠 곳을 고르지 않는 노드(N28)의 형식에는 fix_in이 없다", () => {
    const a = answering({ cause: "code_bug", evidence: "" });
    classifyFailure({ ...base, nodeId: "N28", adapter: a });
    expect(a.reqs[0].jsonSchema).toEqual(classifySchema(["code_bug", "env"]));
    expect(classifySchema(["code_bug"]).required).toEqual(["cause", "evidence"]);
  });
});

describe("N26 인수 테스트의 고칠 곳 (조각 3, 2026-11-27 실제 실행)", () => {
  const f = { ...base, gateSummary: "N26 관문 실패\n- 명령 `npm run -s e2e:android -- tests/e2e/android/S15.yaml`이 통과해야 하는데 실패했습니다 (출력 .4dd/gates/GR13.log)" };
  it("플로우 스크립트가 앱을 만지기 전에 깨지면 code_bug + flow로 골라 N22(플로우) 뒤 N26으로 간다", () => {
    const a = answering({ cause: "code_bug", evidence: "background.js의 http.post에 본문이 없어 Maestro가 멈춤", fix_in: "flow" });
    const r = classifyFailure({ ...f, adapter: a });
    expect(r).toMatchObject({ cause: "code_bug", next: "N22", then: "N26", needsHuman: false });
    expect(a.reqs[0].prompt).toContain("runScript, http 호출");
    expect(a.reqs[0].prompt).toContain("Read로 열어");
  });

  it("앱이 틀리면 정해진 경로(N23) 그대로", () => {
    expect(classifyFailure({ ...f, adapter: answering({ cause: "code_bug", evidence: "안내가 안 나옴", fix_in: "app" }) }).next).toBeUndefined();
  });
});
