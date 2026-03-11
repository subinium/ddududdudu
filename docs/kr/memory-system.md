# Memory System

## 범위

이 문서는 `ddudu`가 memory를 단일 텍스트 파일이 아닌 하나의 서브시스템으로 다루는 방식을 설명한다.

목표는 "노트를 더 많이 저장"하는 게 아니다.
목표는 prompt 페이로드를 제한된 범위 안에 유지하면서 미래 실행을 개선하는 정보를 보존하는 것이다.

## 설계 입장

`ddudu`는 memory를 쓰기 경로, 검색 경로, 승격 정책으로 구분해서 다룬다.

이것들은 별개의 관심사다:

- 쓰기 경로: 관찰 내용이 memory에 들어오는 방식
- 검색 경로: 요청에 어떤 memory가 선택되는지
- 승격 정책: 어떤 일시적 관찰이 지속적인 지식이 되는지

이것들을 하나의 버킷으로 합치면 memory는 빠르게 노이즈가 많아지고 비용이 커진다.

## 목표

- session 간에 유용한 프로젝트와 운영자 지식 보존
- 단기 작업 상태를 장기 지침과 분리
- 미래 작업 완료를 개선하는 정보만 승격
- 검색을 목적 인식적이고 제한된 범위로 유지

## 비목표

- 전체 session 이력을 memory로 재생
- memory를 일반 transcript 아카이브로 사용
- 성공한 모든 실행을 지속적인 지식으로 승격
- memory가 검증이나 레포 검사를 대체하도록 허용

## Memory 레이어

`ddudu`는 현재 memory를 여러 scope으로 모델링한다:

| Scope | 역할 | 예상 수명 |
| --- | --- | --- |
| `global` | 운영자 전체 기본값과 재사용 가능한 개인 설정 | 장기 |
| `project` | 안정적인 레포별 컨벤션 | 장기 |
| `working` | 짧은 작업 버스트 동안 살아남아야 하는 활성 작업 상태 | 단기 |
| `episodic` | 주목할 만한 과거 실행의 압축 요약 | 중기 |
| `semantic` | 재사용될 가능성이 높은 코드베이스나 워크플로우에 관한 사실 | 장기 |
| `procedural` | 반복되는 instruction이나 실행 레시피 | 장기 |

중요한 점은 이 레이어들이 서로 다른 속도로 변화하므로 기본적으로 함께 검색해서는 안 된다는 것이다.

## 저장 모델

현재 파일 레이아웃:

- `~/.ddudu/memory.md` — global memory
- `.ddudu/memory.md` — project memory
- `.ddudu/memory/working.md`
- `.ddudu/memory/episodic.md`
- `.ddudu/memory/semantic.md`
- `.ddudu/memory/procedural.md`

이 레이아웃은 의도적으로 단순하고 내구성 있게 설계됐다.
복잡성은 저장 형식이 아니라 선택과 승격에 있다.

## Backend 모듈성

저장 형식이 memory 계약과 같은 것이어서는 안 된다.

따라서 `ddudu`는 memory를 교체 가능한 구현을 가진 backend 인터페이스로 취급해야 한다.

즉, 호출자는 다음과 같은 연산에 의존해야 한다:

- scope 로드
- scope 저장
- 항목 추가
- scope 초기화

경로 레이아웃이나 파일 변경 세부 사항에 직접 의존해서는 안 된다.

### 왜 중요한가

파일 backend는 투명하고 내구성이 있어서 좋은 기본값이다.

하지만 미래의 backend는 다음을 제공하고 싶을 수 있다:

- 벡터 기반 semantic 검색
- QMD 기반 지식 조회
- 원격 팀 memory 저장소
- 암호화된 로컬 저장소

memory가 하나의 저장 방식에 하드코딩되어 있으면, 이런 실험들이 backend 교체가 아닌 핵심 리팩터링이 된다.

### ddudu 방향

`ddudu`는 다음을 유지해야 한다:

- 안정적인 memory API
- 설정 가능한 backend 선택 지점
- 기본 baseline으로서의 파일 저장소

이렇게 하면 오늘은 시스템을 단순하게 유지하면서 나중에 선택적으로 더 높은 수준의 memory 엔진을 위한 여지를 남긴다.

## 검색 정책

Memory 검색은 목적 인식적이어야 한다.

권장 기본값:

| 목적 | 선호 scope |
| --- | --- |
| execution | `working`, `semantic`, `procedural` |
| planning | `project`, `semantic`, `procedural` |
| review | `episodic`, `semantic`, `project` |
| design | `semantic`, `procedural`, `working` |
| general | `project`, `semantic`, `procedural` |

이것이 `ddudu`가 매 턴마다 모든 memory를 주입하는 대신 요청별로 memory scope를 선택하는 이유다.

## 승격 모델

승격은 설명 가능할 만큼 명시적이고, 불필요한 성장을 피할 만큼 선택적이어야 한다.

### 승격 후보

좋은 후보:

- 레포별 규칙을 인코딩하는 검증된 수정 사항
- 안정적인 절차가 된 반복 명령 시퀀스
- 반복 작업 중 발견된 지속적인 레포 컨벤션
- 다시 중요해질 가능성이 높은 높은 신뢰도의 아키텍처 사실

나쁜 후보:

- raw 대화 요약
- 일회성 디버깅 노트
- 증거 없는 모호한 스타일 선호도
- 코드베이스에 대한 검증되지 않은 주장

### 현재 ddudu 동작

현재 `ddudu`는 성공적인 검증된 적용 후 최소한의 승격 패스를 수행한다:

- semantic memory는 "무엇이 변경됐는지 / 무엇이 검증됐는지 / 왜 중요한지"에 대한 짧은 항목을 받음
- procedural memory는 해당되는 경우 "이 워크플로우를 어떻게 반복하는지"에 대한 짧은 항목을 받음

이것은 의도적으로 보수적이다.

## Promotion 2.0

승격은 이제 하드코딩된 추가가 아닌 점수 기반 파이프라인이다.

구현: `src/core/memory-promotion.ts`

### 후보 추출

각 성공적인 실행에 대해 시스템은 다음에서 후보 레코드를 도출한다:

- 검증 요약
- 변경된 파일
- artifact 페이로드
- 적용 요약
- 반복 명령 패턴

### 점수 차원

각 후보는 가중 복합 점수로 다섯 가지 차원에서 평가된다:

| 차원 | 가중치 | 신호 |
| --- | --- | --- |
| stability | 0.25 | 검증 통과 AND 콘텐츠가 특정 파일/패턴을 참조 |
| reuse | 0.30 | 콘텐츠가 컨벤션, 빌드 명령, 또는 아키텍처 규칙을 설명 |
| specificity | 0.15 | 콘텐츠에 파일 경로, 명령 이름, 또는 구체적인 값 포함 |
| verification | 0.20 | 통과 시 1.0, 건너뜀 시 0.3, 실패 시 0.0 |
| novelty | 0.10 | 기존 항목과 텍스트 중복이 60% 초과 없으면 1.0 |

### 승격 결정

복합 점수가 승격 대상을 결정한다:

- `promote_semantic`: composite >= 0.7 AND stability >= 0.6 AND verification >= 0.5
- `promote_procedural`: composite >= 0.6 AND 콘텐츠에 명령/워크플로우 패턴 있음
- `promote_episodic`: composite >= 0.4 AND composite < 0.7
- `keep_working`: verification < 0.3 (검증되지 않음)
- `discard`: composite < 0.3

### 신뢰도 메타데이터

승격된 항목은 이제 신뢰도 메타데이터가 담긴 YAML frontmatter를 포함한다:

```yaml
---
confidence: 0.85
sourceRunId: "abc123"
promotedAt: "2026-03-11T12:00:00Z"
score: { stability: 0.9, reuse: 0.8, specificity: 0.7, verification: 1, novelty: 0.6, composite: 0.82 }
---
```

이 메타데이터는 선택 사항이며 부가적이다. frontmatter 없는 기존 memory 파일은 변경 없이 계속 동작한다.

## 중복 제거와 병합

중복 제거 없이는 memory 품질이 빠르게 저하된다.

승격 파이프라인은 다음을 지원한다:

- 정규화된 단어 집합에 대한 Jaccard 유사도로 퍼지 중복 제거 (중복 임계값: 중복 > 0.7)
- 0.5-0.7 중복 항목에 대한 병합, 더 구체적인 콘텐츠 선호
- 7일 이상 된 기존 항목보다 후보 점수가 높을 때 교체

## 실패 패턴

### Memory 덤프 검색

모든 scope가 한 번에 주입된다.

효과:

- prompt 성장
- 중복된 지침
- 오래된 규칙이 활성 작업 상태를 압도

### 검증 없는 승격

시스템이 확인되지 않은 결론을 저장한다.

효과:

- 잘못된 신뢰
- 고착된 잘못된 정보

### Procedural 과적합

하나의 성공적인 명령 시퀀스가 보편적인 규칙으로 승격된다.

효과:

- 미래의 오용
- 취약한 자동화

### Working memory 누수

단기 작업 상태가 너무 오래 남아 있다.

효과:

- 오래된 context
- 관련 없는 검색

## ddudu 구현 노트

현재 구현이 지원하는 것:

- scope별 memory 파일
- 목적 인식 memory 선택
- 검증된 적용 후 기본 semantic/procedural 승격
- 점수 기반 승격 후보 (Promotion 2.0)
- Jaccard 기반 중복 제거 및 병합 정책
- 승격된 항목에 YAML frontmatter로 신뢰도 메타데이터

아직 제공하지 않는 것:

- 항목이 왜 승격됐는지 설명하는 memory 인스펙터
- 점수 기반 파이프라인을 검증 플로우에 자동 연결 (연결 대기 중)

## 설계 규칙

Memory는 재사용 가능한 운영 지식을 보존해야 한다. 대화 찌꺼기를 쌓는 게 아니다.
