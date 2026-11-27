# 4DD 하네스

에이전트(Claude, Codex)가 4DD 절차대로 개발하게 하는 지휘 프로그램과 검사 도구입니다. 무엇을 왜 만드는지는 [하네스 설계](../docs/harness-design.md)에, 지금 만드는 범위와 순서는 [첫 구현 조각 명세](../docs/harness-slice1.md)에 있습니다.

## 진행

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 시험 프로젝트 원본과 추적 ID 검사 | 끝 |
| 2 | 뼈대: `nodes.yaml`, 원장, `state.json` | 끝 |
| 3 | `4dd check`와 훅 (Claude, Codex, git), `4dd init` | 끝 |
| 4 | 관문 (N22~N26, N28) | 끝 |
| 5 | 도구 어댑터 (Claude, Codex) | Claude 끝. Codex는 훅 신뢰 뒤 확인 |
| 6 | 지휘 루프 `4dd run`, N27 리뷰 세션, `4dd human` | 끝 |
| 7 | 실패 원인 분류(에이전트가 고름) | 끝 |
| 8 | `4dd report` | 끝 |
| 9 | 완료 기준 전체를 Claude와 Codex로 | 끝: 두 도구 모두 T1~T3을 사람 개입 없이 |

### 조각 2 ([명세](../docs/harness-slice2.md))

끝 (2026-11-26, PR #7로 머지).

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 프로젝트 전체 ID(`4dd ids`, 겹침 검사, `--stage 0`)와 시험 프로젝트 `login-reset` | 끝 |
| 2 | `nodes.yaml` 넓히기: N01~N15, 사람 노드, 스테이지 세션, 리뷰 관문, 승인과 패킷 | 끝 (Stage 0·1 관문 검사, 지시문 포함) |
| 3 | 원장과 상태: `review`, `packet`, 넓힌 `human` | 끝 (다음 할 일 정하기의 Stage 0·1 경로 포함) |
| 4 | 사람 명령: `4dd story`, `4dd review`, `4dd human approve·reject --review` | 끝 (검토 페이지, 검토 해시, 셸에서 사람 명령 막기) |
| 5 | 노드 지시문과 `4dd context`의 새 읽을거리 | 끝 (「이번 기능」, PO의 말, Stage 2에서 돌아옴) |
| 6 | 지휘 루프: Stage 0 → 1 → 2 | 끝 (각본 PO로 스토리부터 Stage 2 끝까지, 스테이지 세션, 리뷰 세션 관문) |
| 7 | PO 창구 스킬 `4dd-po`와 검토 페이지 게시 | 끝 (`4dd init`이 스킬을 넣음, 검토 페이지 휴대폰 폭 확인) |
| 8 | `4dd report`에 더하는 질의 | 끝 (기능별 사람 개입·대기·되돌림·스테이지별 토큰) |
| 9 | 완료 기준 전체 | 끝 (두 도구로 각본 PO 실행, 고친 하네스로 Codex 사람 개입 0번. 오너가 PO인 실행 「회원 가입」으로 작업 5개, 거기서 찾은 하네스 문제 다섯 가지 고침) |

### 조각 3 ([명세](../docs/harness-slice3.md))

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 시험 프로젝트 `login-app`(서버 + Expo 앱 뼈대), 로컬 빌드, `4dd device`, Maestro·Playwright 연기 시험 | 끝 (기기 30초, Android 빌드 3분 20초, Maestro 7초, 웹 1.2초) |
| 2 | 기능마다 작업 유형, `platforms`, 플랫폼별 인수 테스트 파일 규칙, `applies_to` | 끝 (디자인 노드 정의와 관문 넷, 픽스처 스크립트로 Android 130초·웹 12초) |
| 3 | 작업 세션에 Figma 열기, 노드별 허용 도구, `4dd figma check` | 끝 (오너가 로그인한 서버 하나만 엶, 한 번에 $0.08, 개인 토큰 없이 프레임 이미지) |
| 4 | N00F 디자인 시스템 | 끝 (실제 실행 4.4분, Figma 변수와 토큰 파일이 같음을 리뷰 세션이 확인, Code Connect는 저장소 짝 파일) |
| 5 | N03W·N03F, 검토 페이지의 화면 | 끝 (물을 것이 남으면 디자인 노드를 미룸, 검토 페이지에 프레임·상태 칩·디자인 시스템) |
| 6 | 프레임 이미지 고정 | 끝 (`4dd figma pin`은 없앰: 개인 토큰 없이 N03F가 이미지를 받고 N04 승인 패킷이 고정) |
| 7 | N26F 화면 비교 | 끝 (위 96·아래 72를 빼고 허용 5%, 지휘 루프가 가상 기기를 띄우고 끔) |
| 8 | Claude 실제 실행 | 끝 (「로그인 화면」 작업 7개, 시나리오 17개가 Android·웹에서 통과, 하네스·환경 문제 여러 개를 고침, 약 $35) |
| 9 | 완료 기준 전체 | |

전체 조각과 순서는 [하네스 설계의 「구현 조각」](../docs/harness-design.md#구현-조각)에 있습니다.

## 폴더

```
src/cli.ts                  4dd 명령의 입구
src/trace.ts                추적 ID 검사 (R, @S, T)
src/nodes.ts                노드 정의 읽기와 형식 검사, 다음 노드, 실패 원인별 경로
src/config.ts               프로젝트 설정(4dd.config.yaml) 읽기
src/ledger.ts               원장(.4dd/events.jsonl) 쓰기·읽기
src/state.ts                원장에서 state.json 만들기
src/glob.ts                 경로 패턴 (writes, locked)
src/lock.ts                 쓰기 잠금 규칙, 기준 해시, 차례 뒤 변경 검사, 원장 지키기
src/hooks.ts                Claude·Codex 훅 입구
src/guard.ts                git pre-commit과 차례 뒤 변경 검사 (원장 기록 포함)
src/git.ts                  git 부르기
src/init.ts                 4dd init
src/gate.ts                 관문: 명령 실행, 추가 검사, test_flaky·env 판정
src/testscan.ts             소스에서 테스트 수와 건너뛰기 표시 세기
src/context.ts              세션에 보낼 지시문과 「이번 작업」 모으기
src/adapters.ts             도구 어댑터: Claude(claude -p), Codex(codex exec)
src/turn.ts                 작업 세션 노드 한 차례
src/setup.ts                4dd setup codex (사용자 설정에 Codex 훅)
src/route.ts                원장만 보고 다음 할 일 정하기
src/run.ts                  4dd run: 지휘 루프 (작업 선택, 노드 실행, 커밋, 횟수 제한, 사람 대기)
src/human.ts                4dd human: 승인, 힌트(학습 후보), 분류 바로잡기, 보류
src/classify.ts             실패 원인 분류 (기계 → 세션이 고름 → 기본 원인)
src/report.ts               4dd report: 개선 지표와 반복 실수·비효율 질의
src/plan.ts                 Stage 0·1의 산출물 읽기: 칸, 물을 것, 스프린트, 검토·패킷 해시 (조각 2)
src/po.ts                   PO 창구의 사람 명령: 4dd story, 4dd review, 검토 승인·되돌림 (조각 2)
src/device.ts               가상 기기 띄우기·끄기 (4dd device, 조각 3)
src/design.ts               디자인 산출물 형식과 관문 검사: 토큰, Code Connect, 화면 상태, 프레임 (조각 3)
src/figma.ts                Figma 연결 확인 (4dd figma check, 조각 3)
src/visual.ts               화면 비교: 찍은 화면과 고정한 프레임 이미지 (N26F, 조각 3)
src/review.ts               검토 페이지 HTML (N04 스펙·시나리오, N15 목표·백로그·설계)
nodes/nodes.yaml            노드 정의의 원본 (Stage 2)
nodes/instructions/         작업 세션과 리뷰 세션이 받는 노드 지시문
skills/4dd-po/              PO 창구 스킬 원본 (4dd init이 프로젝트의 .claude/skills/로 넣음)
test/                       하네스 테스트
fixtures/login-backend/     시험 프로젝트 원본 (4dd init이 복사해서 돌림)
fixtures/login-reset/       로그인이 끝난 시험 프로젝트 (조각 2, 두 번째 기능을 더함)
fixtures/login-app/         로그인·회원 가입이 끝난 서버와 Expo 앱 뼈대 (조각 3, 화면 기능을 더함)
fixtures/login-reset.story.md  조각 2 시험 스토리 (PO 창구가 4dd story로 넣음)
```

## 쓰는 법

Node 24 이상이 필요합니다. TypeScript 파일을 Node가 바로 실행하므로 빌드 단계가 없습니다.

```bash
npm install
npm test
npm run typecheck
node src/cli.ts check trace fixtures/login-backend
node src/cli.ts status <프로젝트 폴더>
node src/cli.ts init <새 폴더>          # 시험 프로젝트를 새 git 저장소로
node src/cli.ts check path specs/login/spec.md --node N22 --root <프로젝트 폴더>
node src/cli.ts gate N24 --task T1 --run NR1 --root <프로젝트 폴더>
node src/cli.ts context N22 --task T1 --root <프로젝트 폴더>
node src/cli.ts turn N22 --task T1 --agent claude --root <프로젝트 폴더>   # 실제 에이전트를 돌림 (사용량이 듦)
node src/cli.ts setup codex                                              # 한 번만. 그다음 codex에서 /hooks로 신뢰
node src/cli.ts run --agent claude --max-tasks 1 --root <프로젝트 폴더>   # 지휘 루프 (실제 에이전트, 사용량이 듦)
node src/cli.ts human hint "<힌트>" --root <프로젝트 폴더>                 # 사람을 기다릴 때
```

`4dd check`의 종료 코드는 0 통과, 2 막음, 1 잘못된 사용이나 오류입니다. 추적 검사의 주의는 통과로 칩니다. 전체 명령은 `node src/cli.ts`를 인자 없이 돌리면 나옵니다.
