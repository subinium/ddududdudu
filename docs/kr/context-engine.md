# Context Engine

## 범위

이 문서는 harness가 모델 요청에 무엇을 포함할지 결정하는 방식을 다룬다.

문제는 "context를 더 많이 넣는 방법"이 아니다.
문제는 "다음 결정을 위한 신호를 어떻게 극대화할 것인가"다.

## 철학

context의 품질이 양보다 중요하다.

나쁜 context는 강력한 모델을 약하게 만든다.
좋은 context는 같은 모델을 눈에 띄게 더 잘 동작하게 만든다.

그래서 context 엔지니어링은 transcript 누적이 아니라 쿼리 플래닝 문제로 다뤄야 한다.

## 목표

- prompt 페이로드를 고신호(high-signal)로 유지
- 모든 것을 재생하지 않고도 연속성 보존
- 여러 worker 타입과 provider runtime 지원
- 누락되거나 노이즈가 많은 context로 인한 재시도 감소

## 비목표

- 무조건적인 token 수 최소화
- 기본적으로 전체 transcript 이력 재생
- 모든 instruction 소스를 동등하게 취급

## Context 레이어

`ddudu`는 context를 별개의 레이어로 분리한다:

| 레이어 | 내용 | 예상 안정성 |
| --- | --- | --- |
| Stable kernel | tool 사용, 검증, 위임, 신뢰에 관한 운영 규칙 | 매우 안정적 |
| Project instruction layer | `.ddudu/DDUDU.md`, 규칙, prompt, 호환 instruction 파일 | 레포 내에서 안정적 |
| Memory layer | 선택된 working, semantic, procedural, episodic memory | 준안정적 |
| Request snapshot | 관련 파일, artifact, 변경된 파일, todo 상태, 활성 작업 | 매우 동적 |
| Provider session layer | provider별 session 연속성 | runtime 의존적 |

각 레이어가 서로 다른 속도로 변화하기 때문에 이 구분이 중요하다.

## 실패 패턴

### Transcript 팽창

증상:

- 좁은 작업에 전체 대화를 재생
- 줄 단위 수정에 파일 전체 context를 전송
- 구조화된 artifact 대신 산문으로 provider session을 hydrate

효과:

- 지연 시간 증가
- 집중력 분산
- 다음 단계 결정 품질 저하

### Instruction 난립

증상:

- 우선순위 없이 너무 많은 instruction 소스를 병합
- prompt, docs, memory, snapshot에 규칙이 중복

효과:

- 모델이 안내받는 게 아니라 포화 상태가 됨

### 보일러플레이트 검색

증상:

- 읽기 가능한 콘텐츠 대신 raw HTML
- 소스 파일보다 생성된 파일이 상위에 랭크됨
- 변경되지 않은 파일이 활성 변경 작업을 지배

효과:

- token 볼륨은 높지만 작업 관련성은 낮음

### 잘못된 레이어 배치

증상:

- 동적 상태가 system prompt에 인코딩됨
- 지속적인 프로젝트 규칙이 request snapshot에 밀어 넣어짐
- provider session 재사용이 유일한 연속성 메커니즘으로 취급됨

효과:

- 취약한 context 성장과 디버깅하기 어려운 동작

## 설계 휴리스틱

선호:

- 작업 형태가 명확할 때 무거운 검색 전에 실행 형태 분류
- 전체 파일보다 파일 범위
- 일반 읽기보다 심볼 기반 읽기
- transcript 재생보다 타입이 있는 artifact
- 전체 memory 덤프보다 목적 인식 memory 선택
- 활성 코드 변경에 변경된 파일 우선 랭킹
- 충실도가 필요한 경우가 아니면 raw 문서 페이로드보다 읽기 가능한 추출

확신이 없을 때는 더 강한 증거를 가진 더 좁은 context를 선호한다.

## Compaction 규칙

좋은 compaction이 보존하는 것:

- 결정 사항
- 블로커
- 검증 결과
- 다음 단계 handoff 상태

나쁜 compaction이 보존하는 것:

- 모호한 요약 산문
- 낮은 엔트로피의 transcript 패러프레이즈

타입이 있는 artifact는 서술적 요약이 아닌 운영적 의미를 보존하기 때문에 여기서 특히 가치 있다.

## 실행 형태 우선 검색

context 비용은 요청 길이만이 아니라 실행 형태를 따라야 한다.

prompt가 주로 레포 외부의 비교, 리서치, 사실 확인을 요청할 때, 좋은 harness는:

- 무거운 코드 snapshot을 구성하기 전에 요청을 라우팅
- 레포가 명확히 질문의 일부가 아니면 관련 파일 검색과 변경 파일 스캔 생략
- artifact 이월을 작게 유지
- 다음 검색 결정을 개선하지 않는 광범위한 memory나 플래닝 상태 로딩 회피

마찬가지로, 집중된 구현 작업이 자동으로 레포 전체 오케스트레이션이나 플래닝 비용을 지불해서는 안 된다.

한 명의 소유자가 좁은 코드 슬라이스로 시작할 수 있다면, 좋은 harness는 다음을 선호해야 한다:

- 집중된 파일과 artifact 검색
- 직접 또는 단일 소유자 위임 실행
- 관리된 팀 context 전에 경량 scout context

이것이 답변 품질을 약화시키지 않고 지연 시간을 줄이는 가장 쉬운 방법 중 하나다.

## 성능 원칙

목표 지표는 "가장 작은 prompt"가 아니다.

목표 지표는:

- 피할 수 있는 재시도를 방지하는 데 필요한 최소 context
- 다음 행동을 위한 최대 신호

이것은 context 크기 문제가 아니라 context 품질 문제다.

## ddudu 구현 노트

현재 `ddudu`는 다음에 의존한다:

- 슬림한 stable kernel prompt
- 목적 인식 artifact 선택
- 목적 인식 memory 선택
- 작업 유형별 request snapshot
- 외부 리서치를 위한 경량 snapshot
- 명확한 직접, 위임, 팀, 리서치 케이스에 대한 route-before-snapshot
- compaction과 provider `resume` 및 `hydrate`

주요 튜닝 포인트는 더 이상 "prompt를 더 추가"가 아니다.
"더 나은 context를 선택"하는 것이다.
