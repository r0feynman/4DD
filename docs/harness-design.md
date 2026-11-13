# 4DD 하네스 설계

> **상태 (2026-11-13):** 핵심 제안 5가지(설계 ①~⑤)는 **승인됐습니다.** 아래 「결정 사항」도 확정된 내용입니다. 「승인 대기」로 표시한 항목은 아직 제안 단계이고, [nodes.md](nodes.md)와 [workflow.md](workflow.md)에는 반영하지 않았습니다. 목표는 논의를 거치면서 더 구체적으로 바뀌거나 진화할 수 있습니다.

## 목표

4DD 절차를 **하네스 엔지니어링**의 하네스로 만듭니다. 여기서 하네스는 에이전트 주변 환경을 말합니다. 컨텍스트(`AGENTS.md`, 문서), 도구(MCP, 명령), 가드레일(잠금, 훅), 피드백 루프(테스트, 관문, 리뷰), 상태를 설계해서 에이전트가 이 절차대로 앱을 만들거나 기능을 구현하게 합니다.

- **도구 독립:** 같은 하네스가 Claude에서도, Codex에서도 돌아야 합니다. 두 도구가 작업을 주고받는 교대 방식이 아닙니다.
- **범용:** 주로 모바일 앱(React Native + Expo)을 만들고, 웹은 보조로 만듭니다. 백엔드 작업만 하거나 기능 하나만 구현하는 경우도 있습니다.
- **디자인도 에이전트가:** 디자인은 기본적으로 에이전트가 Figma MCP로 만들고, 사람은 일부만 맡습니다. Figma를 거쳐야 Figma 화면을 코드로 옮기는 기능(디자인 컨텍스트, Code Connect)을 쓸 수 있기 때문입니다.

사람 팀은 "Figma와 일치하나?" 같은 판단을 감으로 내리지만, 에이전트에게는 다음 세 가지가 필요합니다.

1. 기계로 확인할 수 있는 판단 기준
2. 스스로 승인하지 못하게 하는 구조
3. 무한 루프를 막는 횟수 제한

## 결정 사항

| 항목 | 결정 | 날짜 |
|---|---|---|
| 핵심 제안 | 설계 ①~⑤ 승인 | 2026-11-13 |
| 모바일 | React Native + **Expo** | 2026-11-13 |
| 빌드 | **로컬 빌드** (`npx expo run:android`, `eas build --local`) | 2026-11-13 |
| 플랫폼 범위 | Mac이 없으므로 **Android 먼저**, iOS는 Mac이 생길 때까지 보류 | 2026-11-13 |
| Figma 요금제 | **Professional** | 2026-11-13 |
| 인수 테스트 도구 | **Maestro** (웹은 Playwright) | 2026-11-13 |
| 화면 비교 기준 | 디자인과 구현의 차이 허용 비율로 판정. **설정으로 바꿀 수 있게** 하고, 지금은 **5%** | 2026-11-13 |
| 강제 규칙 위치 | 4dd 명령 + git 훅 + CI + **Claude 전용 훅** | 2026-11-13 |
| 하지 않기로 한 것 | 상태 기록 실험(도구 사이 인계 시험), Figma 직접 시험(조사로 대체) | 2026-11-13 |

## 빈 곳

| 영역 | ID | 빈 곳 |
|---|---|---|
| A. 상태·데이터 | G1 | 노드 정의가 문서에만 있음 (기계가 못 읽고, 문서끼리 어긋남) |
| | G2 | 노드·스테이지 사이 상태 전달 방식 없음 |
| | G3 | 요구사항 ↔ 시나리오 ↔ 프레임 ↔ 작업 ↔ 테스트 ↔ 코드 연결 없음 |
| B. 판단·관문 | G4 | 판단 기준이 사람 감각에 의존 (Figma 일치 허용 오차, 스펙 일치) |
| | G5 | 되돌림이 전부 N23으로 가고, 무한 루프를 막는 장치 없음 |
| C. 에이전트 통제 | G6 | 테스트·스펙·디자인·기준값을 고쳐서 통과시킬 수 있음 |
| | G7 | 같은 에이전트가 만들고 판정함 (자기 승인) |
| D. 에이전트 디자인 | G8 | 에이전트가 Figma에 그리는 절차 없음 (디자인 시스템 → 와이어 → 화면) |
| | G9 | Figma → 코드 연결 절차 없음 (Code Connect, 디자인 컨텍스트) |
| | G10 | 디자인을 그린 쪽이 구현하고 비교까지 하면 순환이 생김 |
| | G11 | Figma 버전 고정 없음 (어느 버전이 기준인지 모름) |
| E. 사람 접점 | G12 | 사람이 언제, 어디서, 무엇을 승인하는지 정해지지 않음 |
| | G13 | 작업 유형과 무게에 따른 조절 없음 (모바일, 웹, 백엔드, 기능 단위) |
| F. 진화 | G14 | 회고가 대화 중심이라 학습할 데이터가 없고, 개선을 규칙으로 올리는 경로 없음 |
| | G15 | 실행 도구·어댑터 없음 |

## 설계 ① 노드 정의 원본 (G1) — 승인

`4dd/nodes.yaml`을 노드 정의의 **유일한 원본**으로 둡니다. 사람이 보는 [nodes.md](nodes.md)와 Mermaid 맵은 이 파일에서 생성합니다. 하네스도 이 파일을 읽고 움직입니다.

```yaml
N26F:
  stage: 2
  method: figma
  kind: decision
  actor: agent                 # agent | human | agent+human
  applies_to: [mobile, web]    # 이 노드가 켜지는 작업 유형
  reads: ["specs/{feature}/{feature}.feature", figma_frames]
  writes: ["src/**"]           # 이 노드에서 고쳐도 되는 경로
  gate:
    run: "{commands.visual} --scenario {scenario}"
    pass: exit_code == 0
    evidence: tests/visual/__diff__/
  on_fail:
    - when: ui_mismatch          # 실패 원인 어휘
      goto: N24
    - when: design_missing_state
      goto: N03F                 # 사람 승인 필요
  budget: 3                    # 3번 실패하면 사람 호출
```

## 설계 ② 상태 전달: 4층 구조 (G2) — 승인

| 층 | 무엇 | 형식 | 원본인가 |
|---|---|---|---|
| 산출물 | `spec.md`, `.feature`, 코드, Figma 파일 | 원래 형식 | 원본 |
| 원장 | 노드 진입·종료, 관문 결과, 결정, 승인 | `.4dd/events.jsonl` (추가만 함) | 원본 |
| 그래프 | 엔티티와 관계 (온톨로지) | `.4dd/graph.jsonl` | 산출물과 원장에서 자동 추출 |
| 현재 상태 | 지금 어느 기능, 작업, 노드에 있나 | `.4dd/state.json` | 원장에서 다시 만들 수 있음 |

**원칙: 내용은 복사하지 않고 ID와 해시로 가리킵니다.** 사본이 생기면 원본과 어긋나고 토큰도 낭비됩니다. 다음 노드는 필요한 ID만 받아서 `4dd context <노드>` 명령으로 해당 파일과 섹션만 불러옵니다. 이 기록 덕분에 세션이 끊겨도 그 자리에서 다시 시작할 수 있고, 회고에서 쓸 데이터가 쌓입니다.

### 노드 인계 기록

원장의 한 줄입니다. `agent`에는 그 노드를 처리한 도구를 적습니다.

```json
{"type":"handoff","from":"N25","to":"N26","task":"T3","agent":"claude",
 "harness":"0.3.0","schema_version":1,"refs":["R2","S2","F:12-34@v7"],
 "outputs":[{"id":"src/auth/lock.ts","hash":"9f2c…"}],
 "decisions":["잠금 시간은 서버 시계 기준"],"open_questions":[],
 "commit":"a1b2c3d"}
```

커밋에도 `4DD-Node: N24`, `4DD-Refs: R2,S2` 같은 트레일러를 붙입니다. 그러면 코드 변경과 원장이 서로 연결됩니다.

### 스테이지 패킷

각 스테이지 경계에서 산출물을 고정하고, 다음 스테이지는 이 패킷만 믿고 출발합니다.

| 경계 | 고정하는 것 | 승인 |
|---|---|---|
| 0 → 1 | 승인된 R·S 목록, 프레임 ID와 Figma 버전, 해시 | N04 |
| 1 → 2 | `design.md`, `tasks.md` 해시, 스프린트 백로그 | N15 |
| 2 → 3 | 완료 작업, 관문 증거, 기준과 달라진 점 목록 | N29 |
| 3 → 4 | 분류된 피드백 (어느 S·F를 겨냥하는지) | N33 |
| 4 → 다음 | 승격된 개선 항목, 새 하네스 버전 | N44 |

### 에이전트가 노드 하나를 처리하는 순서

1. `state.json`으로 현재 위치를 확인합니다.
2. `nodes.yaml`에서 그 노드의 정의를 찾습니다.
3. `4dd context <노드>`로 노드 지시문과 연결된 산출물만 읽습니다.
4. 작업하고 관문을 실행합니다.
5. 인계 기록과 증거를 원장에 남기고 다음 노드로 갑니다.

### 재사용 전 검증

노드가 산출물을 쓰기 전에, 현재 해시가 승인 당시 해시와 같은지 확인합니다. 다르면 "기준이 승인 없이 바뀐 것"이므로 진행을 멈추고 승인 노드로 돌아갑니다.

## 설계 ③ 가벼운 온톨로지 (G3, G14) — 승인

무거운 온톨로지(OWL/RDF, 그래프 DB)가 아니라 **정해진 타입의 ID, 그 사이의 관계, 통제된 어휘** 정도로 시작합니다.

회고의 진화 루프가 던지는 질문은 결국 "어떤 종류의 X가 어떤 노드에서 무슨 이유로 몇 번 실패했나" 같은 집계 질문입니다. 타입과 관계가 있으면 질의 한 번으로 답할 수 있습니다. 없으면 회고 때마다 에이전트가 로그 전체를 읽고 추측해야 해서 비싸고, 답도 매번 달라집니다.

### 엔티티 타입

괄호 안은 스키마에 쓸 이름입니다.

- 스토리 (`Story`)
- 요구사항 (`Requirement`, ID `R`)
- 시나리오 (`Scenario`, ID `S`)
- 프레임 (`Frame`, ID `F`)
- 컴포넌트 (`Component`, ID `C`)
- 작업 (`Task`, ID `T`)
- 테스트 (`Test`)
- 커밋 (`Commit`)
- 관문 실행 기록 (`GateRun`)
- 결정 (`Decision`)
- 피드백 (`Feedback`)
- 학습 항목 (`Learning`)

### 관계

- 요구사항은 스토리에서 나온다 (`derived_from`)
- 시나리오는 요구사항을 검증한다 (`verifies`)
- 프레임은 시나리오의 한 상태를 그린다 (`depicts`)
- 컴포넌트는 프레임에 쓰인다 (`used_in`)
- 컴포넌트는 코드 컴포넌트에 연결된다 (`maps_to`, Code Connect)
- 작업은 요구사항을 구현한다 (`implements`)
- 테스트는 시나리오를 확인한다 (`checks`)
- 관문 실행 기록은 (노드, 작업)을 평가하고, 결과와 원인을 남긴다 (`evaluates`)
- 결정은 요구사항, 프레임, 기준값을 바꾼다 (`changes`, 승인 필수)
- 학습 항목은 관문 실행 기록과 피드백에서 나오고 (`derived_from`), 승인되면 규칙으로 승격된다 (`promoted_to`)

### 추적 ID 붙이는 법

- `spec.md`의 요구사항에 `R1`, `R2` 같은 ID를 붙입니다.
- 시나리오에 `@R2` 태그를 답니다.
- `tasks.md`의 작업에 `T3 (R2)`처럼 요구사항 ID를 적습니다.
- 테스트도 같은 태그로 묶습니다. Maestro 플로우는 시나리오 ID를 파일 이름으로 씁니다(`S2.yaml`).

그래프는 손으로 관리하지 않습니다. 파일에 붙인 ID(`@R2` 태그, 프레임 주석, 커밋 트레일러, 플로우 파일 이름)와 원장에서 스캐너가 자동으로 뽑습니다. ID가 빠지면 관문의 추적 검사가 잡아냅니다.

### 실패 원인 통제 어휘 — 어휘 목록과 되돌림 노드는 승인 대기

자유 텍스트로 쓰면 집계할 수 없으므로 정해진 단어만 씁니다. 어휘를 추가하려면 승인을 거칩니다.

| 어휘 | 뜻 | 기본 되돌림 |
|---|---|---|
| `code_bug` | 코드가 틀림 | N23 |
| `ui_mismatch` | 화면이 프레임과 다름 | N24 |
| `spec_ambiguous` | 스펙이 모호함 | N02 (사람 승인) |
| `spec_missing_state` | 스펙에 빠진 상태가 있음 | N02 (사람 승인) |
| `design_missing_state` | 그리지 않은 화면 상태가 있음 | N03F (사람 승인) |
| `test_flaky` | 테스트가 불안정함 | N22 |
| `env` | 실행 환경 문제 | 사람 호출 |
| `budget_exceeded` | 횟수 제한 초과 | 사람 호출 |

### 회고 진화 루프

1. **측정:** N42와 N43이 그래프에 질의합니다. 예를 들면 이런 질문들입니다.
   - `spec_ambiguous` 되돌림이 어떤 요구사항에 몰려 있나?
   - N26F 실패 중 `design_missing_state`가 차지하는 비율은?
   - 도구(Claude, Codex)별로 어느 노드에서 횟수 초과가 잦나?
   - 노드별 토큰 사용량과 걸린 시간은?
2. **후보:** 측정 결과를 근거로 학습 항목 후보를 `.4dd/learnings.md`에 만들고, 근거가 된 관문 실행 기록 ID를 함께 남깁니다.
3. **승격:** 사람이 승인하면 `nodes.yaml`, 노드 지시문, 관문, 스킬에 반영하고 하네스 버전을 올립니다.
4. **효과 검증:** 원장에 하네스 버전이 기록되어 있으므로, 다음 스프린트에 그 지표가 실제로 나아졌는지 버전 전후로 비교합니다. 나빠졌으면 되돌립니다.

에이전트가 혼자서 규칙을 늘리지 못하게 하는 장치이기도 합니다.

## 설계 ④ 에이전트가 하는 디자인 (G8~G11) — 승인

### 조사로 확인한 사실 (2026-11-13)

- **흐름:** Figma가 디자인을 완성된 코드로 뽑아 주는 방식이 아닙니다. Figma MCP가 디자인 정보(구조, 변수, 스크린샷, 연결된 컴포넌트)를 넘기면, 에이전트가 그걸 참고해 우리 코드베이스에 맞게 구현합니다. Figma와 OpenAI 모두 MCP 출력(기본 React + Tailwind)을 "구조 참고용"으로 다루라고 안내합니다.
- **공식 스킬:** Claude와 Codex 양쪽에서 같은 스킬을 쓸 수 있습니다.
  - 그리기: `figma-generate-library`(디자인 시스템), `figma-generate-design`, `figma-use`(화면)
  - 구현: `figma-implement-design`
  - 디자인 규칙 스킬은 `CLAUDE.md`와 `AGENTS.md` 양쪽 형식을 지원합니다.
- **Professional 요금제 조건:**
  - Code Connect를 쓸 수 있습니다. Full 또는 Dev 시트가 필요하고, 활성 라이브러리 1개와 활성 프레임워크 1개로 제한됩니다. React Native 하나로 모바일과 웹(Expo 웹)을 같이 다루면 이 제한에 걸리지 않을 가능성이 큽니다(미확인).
  - MCP 읽기 호출은 하루 200회, 분당 10회로 제한됩니다. 쓰기 도구는 이 제한에서 빠집니다.
  - 캔버스 쓰기(`use_figma`)도 쓸 수 있습니다. 베타 기간에는 무료입니다.
- **React Native:** Code Connect가 공식 지원합니다. MCP 기본 출력은 웹용이므로, Code Connect 라벨을 React Native로 맞추고 "웹 코드는 구조 참고용이고 React Native로 옮겨 쓴다"는 규칙을 지시문에 넣습니다.

### 바뀌는 노드 — 승인 대기

| 노드 | 내용 |
|---|---|
| N00F 디자인 시스템 준비 (신규, 프로젝트당 1회) | Figma 변수(색, 간격, 타이포)와 컴포넌트를 만들고, Code Connect로 React Native 컴포넌트에 연결합니다. 이게 없으면 Figma → 코드 결과가 날것의 덩어리가 됩니다. |
| N03F → 두 단계 | ① 와이어프레임: 흐름과 상태 체크리스트(성공, 실패, 빈 상태, 로딩, 오류)를 다룹니다. ② 화면: 컴포넌트와 변수만 써서 완성합니다. |
| 프레임 키 | 사람이 읽는 이름은 `Login/Locked`로 짓되, 기계가 쓰는 키는 Figma `node-id`와 버전을 씁니다. |
| N04 디자인 리뷰 | L1: 별도 리뷰 세션이 스크린샷을 보고 시나리오와 상태 체크리스트를 대조합니다. L2: 사람이 승인하는데, 프로필에 따라 표본만 볼 수도 있습니다. |
| N24 UI 구현 | 고정된 버전의 프레임에서 `get_design_context`로 정보를 받아, Code Connect 컴포넌트로 구현합니다. |
| N26F | 고정 버전의 Figma 프레임 이미지와 실제 화면을 비교합니다. 허용 비율은 설정값입니다(아래). |

### 화면 비교 기준 (N26F) — 결정

- 판정은 "디자인과 구현의 차이 비율"로 합니다. **기본값 5%**이고 설정으로 바꿀 수 있습니다.
- 업계 표준 수치는 없습니다. 참고로 Maestro `assertScreenshot`의 기본값은 95% 일치(5% 허용), Playwright는 기본 0 허용입니다. Figma와 실제 화면 비교는 폰트 렌더링과 안티앨리어싱 차이 때문에 맞게 구현해도 픽셀이 완전히 같지 않습니다.
- Maestro에는 `thresholdPercentage = 100 - tolerance_percent`로 넘깁니다. Maestro는 이 값에 변수를 받습니다.
- 정확도를 위해 기기와 해상도를 고정하고, 상태 표시줄처럼 매번 바뀌는 영역은 비교에서 뺍니다(`cropOn`).
- **기준값은 사람이 정하는 기준입니다.** 에이전트는 바꿀 수 없게 잠그고, 바꾸려면 결정 기록과 승인을 거칩니다. 에이전트가 기준을 느슨하게 바꿔 통과시키는 것을 막기 위해서입니다.

```yaml
# 4dd.config.yaml 일부
visual:
  tolerance_percent: 5        # 디자인과 구현 차이 허용 비율
  overrides:                  # 시나리오별 예외 (선택)
    S7: 8                     # 예: 애니메이션이 있는 화면
  device: android_pixel_7_api_34
  ignore: [status_bar]
```

### 순환 문제 (G10)

같은 세션이 그리고 구현하고 비교까지 하면 Figma 관문이 독립적인 검사가 되지 못합니다.

- **세션 분리:** 디자인 세션, 구현 세션, 리뷰 세션을 나눕니다. 같은 도구여도 됩니다.
- **버전 고정:** 구현 노드(N2x)에서는 고정된 버전의 Figma 프레임에 쓸 수 없게 잠급니다. 디자인을 바꾸려면 N03F로 되돌아가 결정 기록을 남기고 승인을 받아야 합니다.

## 설계 ⑤ 판단·통제·사람 접점 (G4~G7, G12, G13, G15) — 승인

### 관문 계약 (G4)

판단 노드마다 실행할 명령, 통과 조건, 남길 증거를 정합니다.

| 노드 | 관문 | 판정 방식 |
|---|---|---|
| N26 인수 테스트 | 해당 시나리오의 Maestro 플로우(웹은 Playwright) 실행 | 기계 (종료 코드) |
| N26F Figma 일치 | 고정 버전 프레임과 화면 비교, 허용 비율 이하 | 기계 |
| N27 스펙 일치 | 추적 검사 + 별도 리뷰 세션 | 기계 + 다른 세션 |
| N28 DoD | 전체 테스트, 잠금 검사, 추적 검사 | 기계 |

### 되돌림과 횟수 제한 (G5)

- 실패 원인 어휘로 갈 곳을 정합니다 (설계 ③ 표 참고).
- **승인 대기:** N26F 실패를 N23이 아니라 N24로 보냅니다. 실패한 화면 비교가 이미 Red 역할을 하므로, 화면을 조금 고치려고 단위 테스트부터 쓸 필요가 없습니다.
- 같은 관문에서 정해진 횟수만큼 실패하면 멈추고 사람을 부릅니다. 이때 실패 기록 요약을 함께 넘깁니다. 횟수(초안 3회)는 승인 대기입니다.
- "코드 문제"는 에이전트가 직접 되돌리고, "기준(스펙·디자인·기준값) 문제"는 에이전트가 판단만 한 뒤 사람이 승인해야 되돌립니다.

### 쓰기 잠금 (G6)

- 노드마다 수정할 수 있는 경로(`writes`)를 정합니다. 예를 들어 N23~N25에서는 `.feature`, Maestro 플로우, `spec.md`, `4dd.config.yaml`, 고정된 버전의 Figma 프레임을 고칠 수 없습니다.
- N28 관문에서 추가로 검사합니다: 테스트 수가 줄지 않았나, 테스트를 건너뛰는 표시가 새로 생기지 않았나, 기준선 이미지나 기준값이 무단으로 바뀌지 않았나.

### 강제 규칙을 거는 곳 — 결정

규칙은 `nodes.yaml`과 `4dd` 명령 **한 곳에만** 정의합니다. 나머지는 `4dd` 명령을 부르는 입구일 뿐입니다. 그래야 도구가 달라도 같은 규칙이 적용되고, 규칙이 여러 곳에서 어긋나지 않습니다.

| 층 | 언제 걸리나 | 하는 일 | 적용 도구 |
|---|---|---|---|
| ④ Claude 전용 훅 | 파일을 고치기 **직전** (가장 빠름) | 편집 전 `4dd check path <파일>`로 잠긴 경로를 막음, 세션 시작 시 `4dd context`를 넣어 줌, 세션 끝에 인계 기록이 남았는지 확인 | Claude |
| ① `4dd` 명령 | 에이전트가 직접 부를 때 | `4dd context`, `4dd gate <노드>`, `4dd check`, `4dd advance` | 공통 |
| ② git 훅 | 커밋할 때 | pre-commit에서 잠금 검사와 추적 검사, commit-msg에서 트레일러 확인 | 공통 |
| ③ CI | PR을 올릴 때 (마지막 관문) | 모든 관문을 다시 실행. git 훅은 건너뛸 수 있어도 CI는 못 건너뜀 | 공통 |

Codex는 ①~③으로 같은 규칙을 적용받습니다. Codex 쪽에도 훅 기능이 있는지는 확인한 뒤 ④에 추가합니다.

### 승인 3층 (G7, G12)

| 단계 | 누가 | 언제 |
|---|---|---|
| L0 기계 관문 | 하네스 | 매 반복마다 |
| L1 별도 리뷰 | 다른 에이전트 세션 (같은 도구여도 됨) | 작업과 디자인이 끝날 때 |
| L2 사람 | PO, 디자이너, 개발 리드 | N04, N12, 스펙·디자인·기준값 변경, 횟수 초과, N33, 머지, 학습 항목 승격 |

사람만 할 수 있는 노드는 N01, N04, N33, N44입니다. 회고의 N42와 N43은 에이전트가 지표를 뽑아 초안을 만들고, 개선 항목을 정하는 건 사람이 합니다.

### 비개발자 입력 경로 (G12)

- **PO:** Git을 쓰지 않아도 됩니다. 채팅, Notion, 이슈 어디든 평범한 말로 스토리를 적으면, 에이전트가 `spec.md`와 `.feature` 초안으로 바꾸고 렌더링된 검토 페이지를 만듭니다. PO는 그 페이지에서 승인하거나 의견을 남깁니다.
- **디자이너 (일부 참여 시):** Figma에서 에이전트가 만든 프레임을 보고 고치거나 승인합니다.

### 작업 유형과 프로필 (G13)

**작업 유형**에 따라 켜지는 D가 다릅니다. 노드의 `applies_to`로 정합니다.

| 작업 유형 | 켜지는 D | 인수 테스트 |
|---|---|---|
| 모바일 앱 | 4개 전부 | Maestro (Android) |
| 웹 | 4개 전부 | Playwright |
| 백엔드 | Figma를 뺀 3개 (시나리오는 API 수준) | API 테스트 |
| 기능 단위 | 기능에 따라 위 셋 중 하나를 따름 | — |

**무게(프로필)** 는 따로 고릅니다.

| 프로필 | 쓰는 노드 | 언제 |
|---|---|---|
| `full` | 작업 유형에 맞는 노드 전부 | 새 기능, 사용자에게 보이는 변경 |
| `lite` | Figma 노드 생략 → 디자인 시스템 기본값 사용, 회고 축소 | 작은 변경, 내부 도구, Figma 호출 한도를 아낄 때 |
| `spike` | N21~N25만, 결과물은 버림 | 기술 검증 |

### 실행 도구 어댑터 (G15)

하네스가 특정 도구에 묶이지 않도록, 프로젝트마다 `4dd.config.yaml`에 명령을 등록합니다.

```yaml
work_type: mobile             # mobile | web | backend | feature
profile: full
platforms: [android]          # Mac이 생기면 ios 추가
commands:
  build: npx expo run:android
  unit: npx jest
  acceptance: maestro test .maestro/
  visual: 4dd visual --platform android
```

## 다음 단계

1. 조사가 끝난 내용을 바탕으로 「승인 대기」 항목을 결정합니다: 노드 변경 3가지, 실패 원인 어휘와 되돌림 노드, 횟수 제한.
2. `.feature` 시나리오와 Maestro 플로우를 짝짓는 규칙을 정합니다. Maestro는 Gherkin을 지원하지 않으므로, `.feature`를 기준 문서로 두고 시나리오마다 플로우 파일을 하나씩 둡니다(`@S2` ↔ `S2.yaml`).
3. 확인할 것: Codex의 훅 기능, Figma 프레임 이미지를 Android 기기 해상도로 맞추는 방법.

## 자기 검토

### 1차 검토에서 찾은 문제와 바꾼 점

- 온톨로지를 RDF와 그래프 DB로 잡았는데, 운영 비용이 크고 에이전트가 직접 쓰기 어렵습니다. 파일 안 ID에서 자동으로 뽑는 인덱스로 줄였습니다.
- 인계 기록에 산출물 내용을 담으려 했는데, 토큰이 낭비되고 사본이 어긋납니다. ID와 해시로 가리키는 방식으로 바꿨습니다.
- 같은 세션이 디자인, 구현, 비교를 모두 하면 독립성이 사라집니다. 세션 분리와 버전 고정을 추가했습니다.
- 디자인 시스템 없이 바로 화면부터 그리면 Figma → 코드 품질이 낮습니다. N00F를 제안했습니다.

### 2차 검토에서 찾은 문제와 바꾼 점

- 진화 루프가 개선 효과를 측정할 수 없었습니다. 원장에 하네스 버전을 기록해 전후를 비교하게 했습니다.
- 실패 원인을 자유 텍스트로 쓰면 집계할 수 없습니다. 통제 어휘로 바꿨습니다.
- 목표가 진화하므로 스키마도 바뀔 것입니다. 원장과 그래프에 `schema_version`을 넣었습니다.

### 3차 검토 (결정 사항 반영 후)

- "Claude ↔ Codex 교대"를 전제로 쓴 부분이 있었습니다. 목표는 도구 독립이므로, 교차 리뷰를 "별도 리뷰 세션"으로 바꾸고 인계 실험을 지웠습니다.
- 기준값을 설정으로 바꿀 수 있게 하면 에이전트가 기준을 느슨하게 고쳐 통과시킬 수 있습니다. 기준값 파일을 쓰기 잠금 대상에 넣고, 바꿀 때는 결정 기록과 승인을 거치게 했습니다.
- 규칙을 Claude 훅, git 훅, CI에 따로 쓰면 서로 어긋납니다. 규칙은 `4dd` 명령 한 곳에 두고 나머지는 입구로만 쓰게 했습니다.
- 백엔드 작업에는 Figma 노드가 필요 없습니다. 작업 유형별로 켜지는 노드를 정하게 했습니다.

### 남은 위험

- Figma 쓰기 베타의 안정성과 요금, 도구 이름의 변동
- Professional의 하루 200회 읽기 한도: 화면이 많은 기능에서는 부족할 수 있습니다.
- LLM이 그린 디자인이 무난하고 평범해지는 경향: 디자인 시스템과 참고 화면으로만 일부 보완할 수 있습니다.
- N27의 의미적 일치는 끝까지 완전 자동화가 어렵습니다.
- 쓰기 잠금도 설정 파일로 테스트를 제외하는 식으로 우회할 수 있습니다. 테스트 수 검사와 CI로 일부만 막습니다.
- iOS는 Mac이 생길 때까지 검증되지 않습니다.
- 스프린트(1~4주)는 사람의 리듬입니다. 에이전트는 그 안에서 작업 루프를 여러 번 도는 것으로 보았는데, 이 해석은 확인이 필요합니다.

## 열린 결정

- **디자인 방향:** 지금 설계는 지시대로 "Figma 먼저 → 코드" 방향입니다. Figma 쓰기 베타가 불안정하다고 확인되면, 코드로 시안을 먼저 만들고 `generate_figma_design`으로 Figma에 옮겨 검토하는 역방향을 대안으로 검토할 수 있습니다. 지시와 다른 방향이므로 그때 근거를 보고 오너가 결정합니다.
- **승인 대기 항목:** 노드 변경 3가지(N00F 신설, N03F 분리, N26F → N24), 실패 원인 어휘와 되돌림 노드, 횟수 제한.

## 출처

- [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/)
- [Software Mansion: Harness engineering](https://agentic-engineering.swmansion.com/becoming-productive/harness-engineering/)
- [Figma: Guide to the Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
- [Figma: MCP server best practices](https://help.figma.com/hc/en-us/articles/34855090823063-MCP-server-best-practices)
- [Figma: Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Figma: Rate limits & access](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)
- [Figma: Write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)
- [Figma: Figma skills for MCP](https://help.figma.com/hc/en-us/articles/39166810751895-Figma-skills-for-MCP)
- [Figma: Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect)
- [Figma: Code Connect React / React Native](https://developers.figma.com/docs/code-connect/react)
- [OpenAI: Figma designs to code](https://developers.openai.com/codex/use-cases/figma-designs-to-code)
- [openai/skills: figma-implement-design](https://github.com/openai/skills/blob/main/skills/.curated/figma-implement-design/SKILL.md)
- [Maestro: assertScreenshot](https://docs.maestro.dev/reference/commands-available/assertscreenshot)
- [Maestro: Flows](https://docs.maestro.dev/maestro-flows)
- [Maestro vs Appium vs Detox 2026](https://codersera.com/blog/maestro-vs-appium-vs-detox-2026/)
- [Expo: Local app development](https://docs.expo.dev/guides/local-app-development/)
- [Expo: Local builds](https://docs.expo.dev/build-reference/local-builds)
- [Playwright: SnapshotAssertions](https://playwright.dev/docs/api/class-snapshotassertions)
- [Figma와 실제 화면 비교 도구 정리 (uiprobe)](https://www.uiprobe.io/learn/best-design-qa-tools-compare-figma-live-websites)
