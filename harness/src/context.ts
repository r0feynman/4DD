// 4dd context: 세션에 보낼 지시문과 「이번 작업」을 모은다 (하네스 설계 ② 「에이전트가 노드 하나를 처리하는 순서」).
//
// 파일 전체가 아니라 ID로 찾은 조각만 넣는다. 원장에는 넣은 지시문의 ID와 해시만 남긴다(loaded).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskStartRef, GATE_DIR } from "./gate.ts";
import { git } from "./git.ts";
import { DIR, readEvents, type LedgerEvent } from "./ledger.ts";
import { getNode, instructionPath, type NodeSet } from "./nodes.ts";
import { checkProject, scenariosForTask, type FeatureTrace } from "./trace.ts";

export const HUMAN_DIR = `${DIR}/human`;

export interface Loaded {
  kind: "instruction" | "skill" | "learning" | "file";
  id: string;
  hash?: string;
}

export interface BuiltContext {
  prompt: string;
  loaded: Loaded[];
}

const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

function featureOf(root: string, task: string): FeatureTrace | undefined {
  return checkProject(root).find((t) => t.tasks.some((x) => x.id === task));
}

/** .feature에서 배경과 시나리오 블록(위의 태그 줄 포함)을 잘라 낸다. */
export function scenarioBlocks(text: string, ids: string[]): string {
  const lines = text.split(/\r?\n/);
  const isTag = (l: string) => l.trim().startsWith("@");
  const isScenario = (l: string) => /^\s*(시나리오 개요|시나리오|Scenario Outline|Scenario Template|Scenario|Example)\s*:/.test(l);
  const starts: { start: number; id: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isScenario(lines[i])) continue;
    let s = i;
    while (s > 0 && (isTag(lines[s - 1]) || lines[s - 1].trim().startsWith("#"))) s--;
    const tags = lines.slice(s, i).join(" ");
    const m = /@(S\d+)\b/.exec(tags);
    starts.push({ start: s, id: m ? m[1] : null });
  }
  const out: string[] = [];
  const bg = lines.findIndex((l) => /^\s*(배경|Background)\s*:/.test(l));
  if (bg >= 0) {
    const end = starts.find((x) => x.start > bg)?.start ?? lines.length;
    out.push(lines.slice(bg, end).join("\n").trimEnd());
  }
  starts.forEach((x, k) => {
    if (x.id && ids.includes(x.id)) {
      const end = starts[k + 1]?.start ?? lines.length;
      out.push(lines.slice(x.start, end).join("\n").trimEnd());
    }
  });
  return out.join("\n\n");
}

function lastFor<T extends LedgerEvent["type"]>(events: LedgerEvent[], type: T, pred: (e: Extract<LedgerEvent, { type: T }>) => boolean) {
  return events.filter((e): e is Extract<LedgerEvent, { type: T }> => e.type === type && pred(e as Extract<LedgerEvent, { type: T }>)).at(-1);
}

export interface ContextOptions {
  root: string;
  nodes: NodeSet;
  nodeId: string;
  task: string;
}

export function buildContext(opts: ContextOptions): BuiltContext {
  const { root, nodes, nodeId, task } = opts;
  const node = getNode(nodes, nodeId);
  const loaded: Loaded[] = [];
  const parts: string[] = [];

  parts.push(`# 4DD 하네스 · ${node.id} ${node.name} · 작업 ${task}`);
  const writes = node.writes.length ? node.writes.map((w) => `\`${w}\``).join(", ") : "없음 (읽기 전용)";
  parts.push(
    [
      "당신은 4DD 하네스가 띄운 세션입니다. 이번 차례에는 아래 노드 하나만 처리하고 끝냅니다.",
      "- 다음 노드로 넘어가거나 관문을 판정하지 않습니다. 끝나면 하네스가 관문을 돌립니다.",
      `- 이 노드에서 고칠 수 있는 곳: ${writes}. 다른 곳을 고치려 하면 막히고, 고쳐도 하네스가 되돌립니다.`,
      "- 커밋하지 않습니다. 하네스가 합니다.",
      "- 테스트는 `npx vitest run <파일>`로 직접 돌려 봐도 됩니다.",
    ].join("\n"),
  );

  const ipath = instructionPath(nodes, nodeId);
  if (ipath) {
    const text = readFileSync(ipath, "utf8");
    parts.push(text.trim());
    loaded.push({ kind: "instruction", id: nodeId, hash: shortHash(text) });
  }

  const trace = featureOf(root, task);
  const t = trace?.tasks.find((x) => x.id === task);
  const work: string[] = ["## 이번 작업"];
  if (trace && t) {
    const scen = scenariosForTask(trace, task);
    const reqIds = [...new Set([...t.reqs, ...scen.flatMap((s) => s.reqs)])];
    if (node.reads.includes("task")) {
      work.push(`### 작업 (${trace.dir}/tasks.md)\n- ${t.id} ${t.title} (${t.reqs.join(", ")})`);
      work.push(scen.length ? `이 작업에서 통과시킬 시나리오: ${scen.map((s) => `@${s.id}`).join(", ")}` : "이 작업에서 통과시킬 시나리오는 없습니다 (같은 요구사항의 뒤 작업에서 확인합니다).");
    }
    if (node.reads.includes("requirements")) {
      const reqs = trace.requirements.filter((r) => reqIds.includes(r.id)).map((r) => `- ${r.id} ${r.text}`);
      work.push(`### 요구사항 (${trace.dir}/spec.md)\n${reqs.join("\n")}`);
    }
    if (node.reads.includes("scenarios") && scen.length) {
      const files = [...new Set(scen.map((s) => s.file))];
      const blocks = files.map((f) => scenarioBlocks(readFileSync(join(root, f), "utf8"), scen.map((s) => s.id))).join("\n\n");
      work.push(`### 시나리오 (${files.join(", ")})\n\`\`\`gherkin\n${blocks}\n\`\`\``);
    }
    if (node.reads.includes("design")) {
      const design = join(root, trace.dir, "design.md");
      if (existsSync(design)) work.push(`### 설계 (${trace.dir}/design.md)\n${readFileSync(design, "utf8").trim()}`);
    }
  }

  const { events } = readEvents(root);
  if (node.reads.includes("diff")) {
    const ref = taskStartRef(events, task);
    const diff = git(root, ["diff", `${ref}..HEAD`, "--", "src", "tests"]).trim();
    work.push(`### 이 작업의 변경분 (git diff ${ref.slice(0, 7)}..HEAD -- src tests)\n\`\`\`diff\n${diff || "(변경 없음)"}\n\`\`\``);
    // 이미 충족된 작업: 구현을 바꾸지 않고 넘어왔으므로, 인수 테스트가 시나리오를 제대로 확인하는지가 유일한 안전장치다.
    const met = events.some((e) => e.type === "node_end" && e.task === task && e.already_met);
    if (met && trace && t) {
      const scen = scenariosForTask(trace, task);
      const files = [...new Set(scen.map((s) => s.file))];
      const blocks = files.map((f) => scenarioBlocks(readFileSync(join(root, f), "utf8"), scen.map((s) => s.id))).join("\n\n");
      const tests = scen
        .map((s) => `tests/acceptance/${s.id}.test.ts`)
        .filter((f) => existsSync(join(root, f)))
        .map((f) => `#### ${f}\n\`\`\`ts\n${readFileSync(join(root, f), "utf8").trim()}\n\`\`\``)
        .join("\n\n");
      work.push(
        [
          "### 이미 충족된 작업",
          "이 작업의 시나리오는 앞 작업의 구현으로 이미 통과해서, 구현을 바꾸지 않고 N23~N25를 건너뛰었습니다.",
          "설계 대조와 함께, 아래 인수 테스트가 시나리오의 조건, 만일, 그러면을 실제로 확인하는지 봅니다. 확인하지 않는 테스트(항상 통과하는 테스트, 단계를 빼먹은 테스트)면 code_bug로 실패시키고 지적에 그 내용을 적습니다.",
          `\`\`\`gherkin\n${blocks}\n\`\`\``,
          tests || "(인수 테스트 파일을 찾지 못했습니다)",
        ].join("\n\n"),
      );
    }
  }
  if (node.reads.includes("last_gate")) {
    const lastEnd = lastFor(events, "node_end", (e) => e.task === task);
    // 마지막 노드가 실패했을 때만 붙인다 (이미 지나간 실패는 넣지 않는다). 관문 요약이나 리뷰 지적, 그리고 실패한 명령의 출력 끝부분.
    if (lastEnd && lastEnd.result === "fail") {
      const summary = join(root, GATE_DIR, `${lastEnd.id}.summary.md`);
      const failed = lastFor(events, "gate_run", (e) => e.run === lastEnd.id && e.result === "fail");
      const log = failed ? join(root, GATE_DIR, `${failed.id}.log`) : "";
      const tail = log && existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-60).join("\n").trim() : "";
      const body = [existsSync(summary) ? readFileSync(summary, "utf8").trim() : "", tail ? `출력 끝부분:\n\`\`\`\n${tail}\n\`\`\`` : ""].filter(Boolean).join("\n\n");
      if (body) work.push(`### 지난 관문 결과 (${lastEnd.node}${failed ? `, ${failed.id}` : ""})\n${body}`);
    }
  }
  if (node.reads.includes("hint")) {
    const hint = lastFor(events, "human", (e) => e.task === task && e.kind === "hint");
    const file = hint ? join(root, HUMAN_DIR, `${hint.id}.md`) : "";
    if (hint && existsSync(file)) work.push(`### 사람이 준 힌트 (${hint.id})\n${readFileSync(file, "utf8").trim()}`);
  }

  parts.push(work.join("\n\n"));
  return { prompt: parts.join("\n\n") + "\n", loaded };
}
