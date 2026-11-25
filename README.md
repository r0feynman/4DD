# 4DD 개발론

**4DD (4 Driven Development)** 는 네 가지 주도 개발을 스크럼 스프린트 안에서 함께 돌리는 앱·웹 개발 방법입니다.

| D | 주도 개발 | 정하는 것 | 산출물 |
|---|---|---|---|
| **S**pec | SDD | 무엇을, 왜, 어떤 구조로 만드나 | `spec.md`, `design.md`, `tasks.md` |
| **B**ehavior | BDD | 사용자 입장에서 어떻게 동작해야 하나 | Given-When-Then 시나리오, 인수 테스트 |
| **D**esign | Figma | 실제로 어떤 화면으로 보이나 | 시나리오별 화면 흐름 프로토타입 |
| **T**est | TDD | 코드가 맞게 동작하나 | 단위 테스트 (Red → Green → Refactor) |

스펙에서 시나리오와 화면이 나오고, 시나리오를 통과시키기 위해 단위 테스트를 반복합니다. 위에서 아래로 갈수록 범위가 좁아집니다.

## 구조

```
스프린트 (한 바퀴, 1~4주)
 └─ 스테이지 (Stage 0~4)
     └─ 노드 (N01, N26F …)
```

| 스테이지 | 이름 | 하는 일 | 노드 |
|---|---|---|---|
| 0 | 백로그 정리 | (프로젝트 처음 한 번: 제품 목표와 완성 조건, 디자인 시스템) 스토리 → `spec.md` → 시나리오 → 와이어프레임 → Figma 화면 → 승인 | N00, N00F, N01~N04 |
| 1 | 스프린트 플래닝 | 목표 설정 → 준비 확인 → `design.md` → `tasks.md` | N11~N15 |
| 2 | 개발 | 인수 테스트 → TDD 루프 → 인수·Figma·스펙·DoD 확인 | N21~N29, N2D |
| 3 | 스프린트 리뷰 | 시나리오 기준 시연 → Figma 비교 → 스펙 대조 → 피드백 | N31~N33 |
| 4 | 회고 | 돌아보기 → 스펙·화면 품질 → 테스트 지표 → 개선 항목 (완성 조건을 모두 채웠으면 프로젝트 끝) | N41~N44 |

전체 노드 맵과 되돌림 경로는 [docs/workflow.md](docs/workflow.md)에 있습니다.

## 규칙

1. **스펙이 기준입니다.** 코드와 스펙이 다르면 둘 중 하나를 고칩니다. 둘이 어긋난 채로 두지 않습니다.
2. **스펙은 계속 갱신합니다.** 리뷰에서 나온 피드백은 `spec.md`에 반영합니다.
3. **Figma도 스펙의 일부입니다.** 디자인이 바뀌면 시나리오와 인수 테스트도 같은 스프린트 안에서 함께 고칩니다.
4. **텍스트 시나리오가 Figma보다 우선입니다.** 화면에 드러나지 않는 규칙은 시나리오에만 남기 때문입니다.

## DoD (완료 기준)

다음 네 가지를 모두 충족해야 작업이 끝납니다. 화면이 없는 작업 유형(백엔드 등)은 네 번째 항목을 뺍니다.

- [ ] 스토리의 BDD 시나리오가 모두 통과
- [ ] 새 코드는 TDD로 작성 (단위 테스트 포함)
- [ ] CI에서 전체 테스트 통과
- [ ] 화면이 Figma 프레임과 일치

## 문서

| 문서 | 내용 |
|---|---|
| [docs/workflow.md](docs/workflow.md) | 스프린트·스테이지·노드 맵 (Mermaid), 되돌림 경로, 실패 원인, 화면이 없는 작업 유형, 서비스 완성 |
| [docs/nodes.md](docs/nodes.md) | 모든 노드의 스테이지, 방법론, 종류, 담당, 산출물, 다음 노드 |
| [docs/glossary.md](docs/glossary.md) | 용어집: 스프린트, 스테이지, 노드, 노드 ID 규칙 등 |
| [docs/figma-bdd.md](docs/figma-bdd.md) | BDD 시나리오와 Figma 프레임을 짝짓는 방법 |
| [docs/harness-design.md](docs/harness-design.md) | 4DD를 Claude·Codex 어디서나 도는 하네스로 만드는 설계: 사람 개입을 줄이며 서비스를 완성하고 스프린트마다 스스로 개선하는 방법 (승인된 결정과 열린 결정) |
| [docs/harness-slice1.md](docs/harness-slice1.md) | 하네스 첫 구현 조각 명세: 백엔드 기능 하나가 Stage 2를 사람 손 없이 도는 것부터. 실행 방식, `4dd` 명령, 원장 이벤트, 구현 순서, 완료 기준 |
| [templates/specs/example/](templates/specs/example/) | `spec.md`, `design.md`, `tasks.md`, `.feature` 예시 |
| [docs/changelog.md](docs/changelog.md) | 변경 기록 (최근 것부터) |
| [site/index.html](site/index.html) | 한 페이지로 보는 4DD 개발론 (브라우저에서 열기) |

### 두 형식

이 문서들은 두 형식으로 유지합니다. 저장소 문서가 원본이고, 오너는 그림으로 정리한 아티팩트 [4DD 개발론](https://claude.ai/artifact/QvwmRXisABunc6DLTiaegf)으로 읽습니다. 아티팩트는 [docs-view/build.py](docs-view/build.py)가 저장소 문서로 만들어 내고, 둘이 어긋나지 않게 훅과 CI가 검사합니다. 자세한 규칙은 [CLAUDE.md](CLAUDE.md)에 있습니다.

## 프로젝트에 적용할 때 폴더 구조

```
specs/
  product.md       # 제품 목표와 완성 조건 (N00, 프로젝트당 1회)
  <기능>/
    spec.md        # 요구사항 (SDD, N02)
    design.md      # 설계 (SDD, N13)
    tasks.md       # 작업 목록 (SDD, N14)
    <기능>.feature # 시나리오 (BDD, N03) + Figma 프레임 링크 (N03F)
src/
tests/
  unit/            # 단위 테스트 (TDD, N23~N25)
  acceptance/      # 인수 테스트 (BDD, N22)
  visual/          # Figma 프레임과 스크린샷 비교 (N26F)
```
