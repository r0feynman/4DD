# 4DD 스프린트 워크플로우

스프린트 한 바퀴는 **Stage 0~4**로 나뉘고, 각 스테이지 안에 노드가 있습니다.

```
스프린트 (한 바퀴, 1~4주)
 └─ 스테이지 (Stage 0~4)
     └─ 노드 (N01, N26F …)
```

## 노드 맵

- 사각형: 작업 노드
- 마름모: 판단 노드
- 둥근 모양: 반복 노드 (N2D 데일리 스크럼)
- 점선: 스펙이나 디자인을 바꿔야 해서 앞 스테이지로 돌아가는 경로

```mermaid
flowchart TD
  subgraph SPRINT["스프린트 1회 · 1~4주"]
    direction TB
    subgraph ST0["Stage 0 · 백로그 정리"]
      N01["N01<br/>사용자 스토리"] --> N02["N02<br/>spec.md 작성"] --> N03["N03<br/>BDD 시나리오"] --> N03F["N03F<br/>Figma 화면 흐름"] --> N04{"N04<br/>스펙·화면 승인?"}
      N04 -- 스펙 수정 --> N02
      N04 -- 화면 수정 --> N03F
    end
    subgraph ST1["Stage 1 · 스프린트 플래닝"]
      N11["N11<br/>목표 설정"] --> N12{"N12<br/>스펙·시나리오·화면<br/>준비됐나?"}
      N12 -- 예 --> N13["N13<br/>design.md 작성"] --> N14["N14<br/>tasks.md 작업 분해"] --> N15["N15<br/>스프린트 백로그 확정"]
    end
    subgraph ST2["Stage 2 · 개발"]
      N2D(["N2D<br/>데일리 스크럼"])
      N21["N21<br/>작업 선택"] --> N22["N22<br/>인수 테스트 작성"] --> N23["N23<br/>Red"] --> N24["N24<br/>Green"] --> N25["N25<br/>Refactor"] --> N26{"N26<br/>인수 테스트 통과?"}
      N26 -- 예 --> N26F{"N26F<br/>Figma 일치?"}
      N26F -- 예 --> N27{"N27<br/>스펙 일치?"}
      N27 -- 예 --> N28{"N28<br/>DoD 충족?"}
      N28 -- 예 --> N29["N29<br/>tasks.md 갱신"]
      N26 -- 아니오 --> N23
      N26F -- 아니오 --> N23
      N27 -- 아니오 --> N23
      N28 -- 아니오 --> N23
      N29 -- 남은 작업 --> N21
      N2D -. 매일 .-> N21
    end
    subgraph ST3["Stage 3 · 스프린트 리뷰"]
      N31["N31<br/>시나리오 기준 시연"] --> N31F["N31F<br/>Figma와 나란히 비교"] --> N32["N32<br/>스펙 대조 검증"] --> N33["N33<br/>이해관계자 피드백"]
    end
    subgraph ST4["Stage 4 · 회고"]
      N41["N41<br/>잘된 점·아쉬운 점"] --> N42["N42<br/>스펙·화면 품질 점검"] --> N43["N43<br/>테스트 지표 점검"] --> N44["N44<br/>개선 항목 도출"]
    end
  end

  N04 -- 승인 --> N11
  N12 -- 아니오 --> N01
  N15 --> N21
  N29 -- 모두 완료 --> N31
  N26F -. 디자인 변경 .-> N03F
  N27 -. 스펙 변경 .-> N13
  N33 -- 새 요구 --> N02
  N33 -- 화면 수정 --> N03F
  N33 --> N41
  N44 -- 다음 스프린트 --> N11

  classDef sdd fill:#e7ecfb,stroke:#3a5ccc,color:#1b2330,stroke-width:1.5px
  classDef bdd fill:#e1f4ee,stroke:#0f8a6b,color:#1b2330,stroke-width:1.5px
  classDef fig fill:#f9e4ef,stroke:#b02f78,color:#1b2330,stroke-width:1.5px
  classDef tdd fill:#fbe8e3,stroke:#c4452c,color:#1b2330,stroke-width:1.5px
  classDef scrum fill:#eeebf8,stroke:#6b5bb5,color:#1b2330,stroke-width:1.5px
  class N02,N04,N13,N14,N21,N27,N29,N32,N42 sdd
  class N03,N22,N26,N31 bdd
  class N03F,N26F,N31F fig
  class N23,N24,N25,N43 tdd
  class N01,N11,N12,N15,N28,N2D,N33,N41,N44 scrum
```

색: 파랑 SDD · 초록 BDD · 분홍 Figma · 주황 TDD · 보라 스크럼

## 되돌림 경로

| 지점 | 조건 | 돌아가는 곳 | 의미 |
|---|---|---|---|
| N04 | 스펙·화면 미승인 | N02 / N03F | 스펙이나 프로토타입을 고쳐서 다시 리뷰 |
| N12 | 스펙·시나리오·화면 없음 | N01 | 준비 안 된 스토리는 스프린트에 넣지 않음 |
| N26 | 인수 테스트 실패 | N23 | TDD 반복 |
| N26F | Figma와 불일치 | N23 / N03F | 화면을 고치거나, 디자인을 바꿔야 하면 프로토타입으로 |
| N27 | 설계와 불일치 | N23 / N13 | 코드를 고치거나, 스펙을 바꿔야 하면 설계로 |
| N28 | DoD 미충족 | N23 | 완료 기준을 채울 때까지 작업 |
| N33 | 피드백 | N02 / N03F | 스펙이나 화면을 갱신하고 새 요구를 백로그로 |
| N44 | 회고 끝 | N11 | 다음 스프린트 시작 |
