# 4DD 저장소 지침

`AGENTS.md`는 이 파일을 가리키는 링크입니다. Claude와 Codex가 같은 지침을 읽습니다.

## 이 저장소

4DD 개발론(Spec, Behavior, Design, Test 네 가지 주도 개발을 스크럼 스프린트에서 함께 돌리는 방법) 문서와, 이 절차를 Claude·Codex용 하네스로 만드는 설계가 있습니다. 개요는 `README.md`, 하네스 설계는 `docs/harness-design.md`에 있습니다.

## 반드시 지킬 것: 문서 두 형식 동기화

4DD 문서는 두 형식으로 유지하고, 둘이 어긋난 채로 두지 않습니다.

- **저장소 문서가 원본입니다:** `README.md`, `docs/*.md`, `site/index.html`
- **오너는 아티팩트로 읽습니다:** 「4DD 개발론」 https://claude.ai/artifact/QvwmRXisABunc6DLTiaegf
- 아티팩트는 `docs-view/build.py`가 저장소 문서로 만들어 냅니다. 아티팩트를 손으로 고치지 않습니다.
- 아티팩트는 **최대한 시각적으로** 만듭니다 (레인, 카드, 칩, 흐름 화살표, 점 개수). 원문은 펼쳐 보기로 둡니다.
- 원본을 바꾸면 같은 작업 안에서 빌드하고 게시해 맞춥니다. 절차는 `.claude/skills/4dd-docs-sync/SKILL.md` (Claude에서는 `4dd-docs-sync` 스킬)에 있습니다.

강제 장치:

| 장치 | 하는 일 |
|---|---|
| Claude Stop 훅 (`.claude/settings.json`) | 어긋나 있으면 작업을 끝내지 못하게 한 번 막습니다 |
| Claude PostToolUse 훅 | 아티팩트 게시가 빌드 결과와 같은지 확인하고 `docs-view/sync.json`에 기록합니다 |
| Claude PreToolUse 훅 | `docs-view/sync.json`을 손으로 고치지 못하게 막습니다 |
| git pre-commit 훅 (`.githooks/`) | 어긋난 채로 문서를 커밋하지 못하게 막습니다. `git config core.hooksPath .githooks`로 켭니다 |
| CI (`.github/workflows/docs-sync.yml`) | PR과 main에서 `python3 docs-view/build.py check`를 돌립니다 |

Codex는 아티팩트를 게시할 수 없으므로, 문서를 고쳤다면 Claude 세션에서 게시를 마친 뒤 커밋합니다.

## 그 밖의 원칙

- 오너가 명시한 지시와 다른 결론에 이르면, 바꾸기 전에 이유를 설명하고 승인을 받습니다.
- 사용자에게 보이는 글은 한국어로 씁니다.
