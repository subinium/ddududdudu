# Delegation And Artifacts

## 범위

이 문서는 harness가 작업을 worker들에게 어떻게 분배하고, worker들이 결과를 어떻게 교환해야 하는지를 다룬다.

## 철학

delegation은 단순히 agent를 더 많이 쓰는 것이 아니다.
context 부하를 줄이고, 리스크를 격리하고, 수리 루프를 조합 가능하게 만드는 것이다.

따라서 delegation은 신기한 기능이 아니라 시스템 최적화 관점에서 평가해야 한다.

## 목표

- 각 worker의 active context 크기 줄이기
- 필요한 곳에서 리스크 격리
- 결과물 품질 유지
- 리뷰, 수리, 적용 루프를 조합 가능하게 유지

## delegation이 도움이 되는 경우

delegation은 다음을 달성할 때 도움이 된다:

- active context 크기 감소
- 역할을 명확하게 분리
- 더 안전한 격리 경계 생성
- 검증 또는 리뷰 품질 향상

delegation은 보통 그 필요성을 증명해야 한다.

많은 구현 작업에서 더 나은 기본값은:

- 한 명의 owner가 바로 시작할 수 있다면 직접 실행
- 격리나 전문화가 도움이 된다면 위임된 단일 owner
- 여러 독립 단위가 진짜로 병렬로 움직일 수 있을 때만 managed team orchestration

delegation이 해가 되는 경우:

- 이유 없이 단순한 작업을 쪼갤 때
- 부모 transcript를 통째로 모든 자식에게 복사할 때
- 구조화된 결과물 대신 일반적인 산문을 반환할 때

요약하면:

- delegation은 복잡성을 압축해야 한다
- 복잡성을 증폭시켜서는 안 된다

## Research Fan-Out

비교 및 research 프롬프트는 task 형태로 분할하면 효과적인 경우가 많다.

operator가 `A/B/C` research를 요청하면, 유용한 분해 방식은 보통:

- 주제별로 읽기 전용 worker 하나씩
- 해당 worker들이 끝난 후에만 리드 또는 종합 단계 실행

이 방식이 단일 "research" worker가 모든 주제를 순차적으로 확인하면서 UI는 병렬이라고 주장하는 것보다 훨씬 효과적이다.

## 결과물 중심 Delegation

위임하기 전에 다음을 정의해야 한다:

- 목표
- 기대하는 결과물
- 성공 기준
- 제한된 context

이것이 "알아서 해봐"보다 훨씬 신뢰할 수 있다.

또한 provider 간 재시도와 비교도 쉬워진다.

## Typed Artifacts

유용한 artifact 종류:

- `plan`
- `review`
- `patch`
- `briefing`
- `design`
- `research`

유용한 artifact 필드:

- purpose
- files
- findings
- risks
- verification status
- next steps

Typed artifact는 harness가 대화를 재생하는 대신 결정을 넘길 수 있게 해주기 때문에 prompt 비대화를 줄인다.

## 체크리스트와 진행 상황

장기 실행 위임 작업은 가시적인 작업 항목으로 표현될 때 신뢰하기 쉽다.

유용한 체크리스트는 다음을 보여준다:

- pending
- active
- done
- failed
- blocked
- 담당 worker

이것이 일반적인 "agent 실행 중" 표시보다 훨씬 실용적이다.

## 선택적 격리와 검증

모든 위임 작업이 동일한 실행 오버헤드를 부담할 필요는 없다.

유용한 기본값:

- 쓰기 권한이 있거나 위험한 실행에는 격리된 worktree
- 코드를 변경하거나 검증할 것으로 예상되는 worker에는 검증 루프
- 읽기 전용 research worker에는 기본적으로 worktree도 검증도 없음

그렇지 않으면 harness가 진행하는 대신 orchestration 비용을 치르는 데 대부분의 시간을 쓰게 된다.

## 다수의 Reader, 제한된 Writer

병렬성은 모든 worker에게 쓰기 권한을 주는 것과 다르다.

코드 작업에서 유용한 기본값은 보통:

- 다수의 scout 또는 reader
- 한두 명의 writer
- 최종 reviewer 또는 verifier 한 명

이렇게 하면 merge 압력을 줄이면서도 처리량을 높일 수 있다.

## 리뷰와 수리 루프

delegation은 검증과 연결될 때 훨씬 가치 있어진다.

유용한 루프:

1. plan
2. execute
3. verify
4. repair
5. 수리 실패 시 escalate
6. apply 또는 report

이 루프가 초기 생성 품질보다 중요한 경우가 많다.

## 실패 패턴

전형적인 multi-agent 실패:

1. `delegation by default`
   작업 형태와 무관하게 모든 것을 분할한다.

2. `role drift`
   worker가 레이블은 받지만 실제 계약은 없다.

3. `artifact collapse`
   시스템이 typed handoff를 주장하지만 실제로는 요약만 저장한다.

4. `invisible ownership`
   operator가 어떤 worker가 어떤 todo에 연결되어 있는지 알 수 없다.

## ddudu 구현 노트

현재 `ddudu`는 이미 다음을 사용한다:

- mode 인식 delegation
- 분리된 background job
- 선택적 worktree 격리
- typed artifact
- verifier → repair → escalate → apply 흐름
- 항목화된 research fan-out
- managed team 실행으로 escalate하기 전 직접 또는 위임 실행을 기본값으로 사용
- worker 가시적 ownership과 실시간 heartbeat

다음 성숙 단계는 보통 더 많은 subagent가 아니라 더 엄격한 artifact 규율이다.

## 설계 원칙

Worker들은 결정, 증거, 결과물을 교환해야 한다.
transcript 재생을 주요 handoff 메커니즘으로 의존해서는 안 된다.
