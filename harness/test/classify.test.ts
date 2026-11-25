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

  it("세션에게 그 노드의 단어만 주고, 읽기 전용으로 이어 쓴 세션에서 고르게 한다", () => {
    const a = answering({ cause: "code_bug", evidence: "잠금 시각 계산이 틀림" });
    const r = classifyFailure({ ...base, adapter: a });
    expect(r).toMatchObject({ cause: "code_bug", by: "agent", needsHuman: false, evidence: "잠금 시각 계산이 틀림" });
    expect(a.reqs[0]).toMatchObject({ sessionId: "sess-T1", readOnly: true });
    expect(a.reqs[0].jsonSchema).toEqual(classifySchema(["code_bug", "test_flaky", "spec_ambiguous", "spec_missing_state", "env"]));
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
