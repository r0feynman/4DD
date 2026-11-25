# 4DD 하네스

에이전트(Claude, Codex)가 4DD 절차대로 개발하게 하는 지휘 프로그램과 검사 도구입니다. 무엇을 왜 만드는지는 [하네스 설계](../docs/harness-design.md)에, 지금 만드는 범위와 순서는 [첫 구현 조각 명세](../docs/harness-slice1.md)에 있습니다.

## 진행

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 시험 프로젝트 원본과 추적 ID 검사 | 끝 |
| 2 | 뼈대: `nodes.yaml`, 원장, `state.json` | 끝 |
| 3 | `4dd check`와 훅 (Claude, Codex, git) | 다음 |

## 폴더

```
src/cli.ts                  4dd 명령의 입구
src/trace.ts                추적 ID 검사 (R, @S, T)
src/nodes.ts                노드 정의 읽기와 형식 검사, 다음 노드, 실패 원인별 경로
src/config.ts               프로젝트 설정(4dd.config.yaml) 읽기
src/ledger.ts               원장(.4dd/events.jsonl) 쓰기·읽기
src/state.ts                원장에서 state.json 만들기
nodes/nodes.yaml            노드 정의의 원본 (Stage 2)
nodes/instructions/         작업 세션과 리뷰 세션이 받는 노드 지시문
test/                       하네스 테스트
fixtures/login-backend/     시험 프로젝트 원본 (4dd init이 복사해서 돌림)
```

## 쓰는 법

Node 24 이상이 필요합니다. TypeScript 파일을 Node가 바로 실행하므로 빌드 단계가 없습니다.

```bash
npm install
npm test
npm run typecheck
node src/cli.ts check trace fixtures/login-backend
node src/cli.ts status <프로젝트 폴더>
```

`4dd check trace`의 종료 코드는 0 통과, 2 막음(오류 있음), 1 잘못된 사용입니다. 주의는 통과로 칩니다.
