---
name: 4dd-docs-sync
description: 4DD 저장소 문서(README.md, docs/*.md, site/index.html)와 오너용 아티팩트 「4DD 개발론」을 맞추는 절차. 4DD 문서나 docs-view/를 고쳤을 때, 훅이나 git 훅이나 CI가 "동기화 검사 실패"를 알릴 때, 오너가 아티팩트 갱신을 부탁할 때 반드시 쓴다. 저장소 문서만 고치고 끝내지 않는다.
---

# 4DD 문서 두 형식 동기화

4DD 문서는 두 형식으로 유지합니다.

| 형식 | 누가 읽나 | 어디 |
|---|---|---|
| 저장소 문서 (**원본**) | 에이전트 (Claude, Codex) | `README.md`, `docs/*.md`, `site/index.html` |
| 아티팩트 (화면) | 오너 | 「4DD 개발론」 https://claude.ai/artifact/QvwmRXisABunc6DLTiaegf |

아티팩트는 `docs-view/build.py`가 저장소 문서로 **만들어 내는** 화면입니다. 아티팩트 HTML을 손으로 고치지 않습니다. 내용이 다르면 저장소 문서가 기준입니다.

## 언제 쓰나

- `README.md`, `docs/*.md`, `site/index.html`, `docs-view/build.py`, `docs-view/style.css` 중 하나라도 바꿨을 때
- Stop 훅, git pre-commit 훅, CI가 "4DD 문서 동기화 검사 실패"를 알렸을 때
- 오너가 아티팩트를 보여 달라거나 갱신해 달라고 할 때

## 순서

1. **원본 고치기:** 저장소 문서를 고칩니다. 변경이 의미 있으면 `docs/changelog.md` 맨 위에 항목을 추가합니다 (형식은 그 파일 첫머리 참고).
2. **빌드:** `python3 docs-view/build.py build`
   - "빌드 실패"가 나오면 대개 문서 제목이나 표 머리글을 바꿔서 생성기가 못 찾는 경우입니다. 원본 제목을 되돌리거나 `docs-view/build.py`의 해당 함수를 함께 고칩니다.
   - 노드 ID가 `docs/nodes.md`, `docs/workflow.md` 노드 맵, `site/index.html`에서 서로 다르면 빌드가 멈춥니다. 셋을 맞춥니다.
3. **한 번 확인:** `docs-view/dist/`의 페이지를 브라우저로 한 번 봅니다. 오너 화면에 창을 띄우지 않도록 창 없는 모드(headless)로 봅니다. Playwright MCP는 `--headless`로 설정돼 있습니다(2026-11-25 오너 요청). 휴대폰 폭(390px)에서 가로로 넘치지 않는지, 새 내용이 그림·카드로 보이는지 확인합니다. 노드 맵을 바꿨다면 고리가 Stage 0 → 4 → 다음 스프린트 순서인지, 스테이지를 누르면 그 스테이지의 노드가 위에서 아래로 순서대로 열리는지 눈으로 확인합니다. 아티팩트의 노드 맵은 `docs-view/nodemap.js`가 그립니다 (오너가 고른 시안 나).
   - 노드 맵 규칙: 앞 스테이지로 돌아가는 경로는 화살표로 긋지 않고 점선 상자 `R..(["↩ N02<br/>스펙으로"])`로 그립니다. 스테이지 사이는 `ST0 -- … --> ST1`처럼 스테이지끼리 잇습니다. `docs/workflow.md`와 `site/index.html`의 노드 맵은 글자까지 같아야 합니다 (검사가 확인합니다).
4. **게시:** Artifact 도구로 게시합니다. 빌드가 출력한 값을 그대로 씁니다.
   - `url`: `https://claude.ai/artifact/QvwmRXisABunc6DLTiaegf`
   - `file_path`: `docs-view/dist/index.html`
   - `files`: `{"workflow.html": "docs-view/dist/workflow.html", "harness.html": "docs-view/dist/harness.html", "slice1.html": "docs-view/dist/slice1.html", "glossary.html": "docs-view/dist/glossary.html", "changes.html": "docs-view/dist/changes.html"}`
5. **기록 확인:** 게시가 끝나면 PostToolUse 훅이 `docs-view/sync.json`에 기록하고 "기록했습니다"라고 알려 줍니다. 기록을 거부했다면 그 이유(주소 다름, 페이지 빠짐, 빌드 뒤 원본 변경)를 고치고 다시 게시합니다. `sync.json`은 손으로 고치지 않습니다 (훅이 막습니다).
6. **검사:** `python3 docs-view/build.py check` 가 "맞음"이어야 합니다.
7. **커밋:** 문서 변경과 `docs-view/sync.json`을 같은 커밋에 넣습니다.
8. **오너에게 알리기:** 무엇이 바뀌었는지와 아티팩트 링크를 짧게 알립니다.

## 아티팩트 작성 원칙: 최대한 시각적으로

오너는 글보다 그림으로 파악합니다. 새 내용을 아티팩트에 넣을 때는 글을 옮겨 적지 말고 생성기(`docs-view/build.py`)에 시각 요소를 추가합니다.

- 단계와 흐름은 레인, 화살표, 파이프라인으로 그립니다.
- 같은 종류의 항목은 카드나 칩으로 나열하고, 색은 방법론(SDD 파랑, BDD 초록, Figma 분홍, TDD 주황, 스크럼 보라)과 사람 승인(노랑)에만 씁니다.
- 숫자는 큰 숫자 칸이나 점(●)의 개수로 보여 줍니다.
- 원문 전체는 각 페이지 아래 「원문 펼쳐 보기」에 자동으로 들어갑니다. 먼저 보이는 건 시각 요약이어야 합니다.
- 새 문서를 `docs/`에 추가했다면 알맞은 페이지의 「원문」에 넣거나 새 페이지를 `PAGES`에 추가합니다.

## Codex에서 작업할 때

Codex는 claude.ai 아티팩트를 게시할 수 없습니다. 저장소 문서를 고쳤다면 git pre-commit 훅이 커밋을 막습니다. 그때는 Claude 세션에서 이 스킬로 빌드와 게시를 마친 뒤 커밋합니다.
