# Harness 구조

## 범위

이 문서는 coding harness의 주요 아키텍처 레이어와 그 사이의 경계를 설명한다.

명령어 레퍼런스가 아니다.
책임의 분해다.

## 철학

Coding harness는 레이어드 시스템으로 설계되어야 한다.

그 관점이 중요한 이유는 AI 코딩 도구의 많은 실패가 실제로 경계 실패이기 때문이다:

- prompt에 인코딩된 동적 state
- 정책 대신 텍스트에 인코딩된 신뢰
- 명시적인 계약 없는 위임
- 제대로 모델링되지 않은 state를 보완하는 UI

## 레이어 모델

| 레이어 | 주요 책임 | 약할 때 전형적인 실패 |
| --- | --- | --- |
| 실행 커널 | provider runtime, tool 실행, 권한, 전송 | 안전하지 않거나 일관성 없는 실행 |
| Context engine | 검색, prompt 조립, 압축, memory 로딩 | 노이즈 많거나, 느리거나, 정보 부족한 결정 |
| Session/state 레이어 | 정규 transcript, artifact, job, checkpoint, provider state | 취약한 연속성과 약한 복구 |
| 오케스트레이션 레이어 | 라우팅, 위임, 검증, 에스컬레이션, 복구 | 낭비된 token 또는 과부하된 워커 |
| 운영자 표면 | 가시성, 검사, 진행, 복구 UX | 낮은 신뢰와 위임이 어려워짐 |

## 소유권 모델

각 레이어는 좁은 범위의 관심사를 소유해야 한다.

| 레이어 | 소유해야 할 것 | 소유하면 안 될 것 |
| --- | --- | --- |
| 실행 커널 | runtime 호출, tool 호출, 권한 강제 | 장기 프로젝트 memory, UI state |
| Context engine | prompt 선택, 검색, 압축, memory 선택 | 실행 정책에 대한 최종 권한 |
| Session/state 레이어 | 지속적인 작업 state, transcript, artifact, job | provider 특정 숨겨진 prompt 동작 |
| 오케스트레이션 레이어 | 라우팅, 위임, 복구 흐름, 에스컬레이션 | 저수준 전송 세부 사항 |
| 운영자 표면 | 관찰 가능성과 제어 | 작업 상태의 기준점 |

이 경계들이 무너지면 복잡성이 빠르게 증가한다.

## 지원 시스템

핵심 레이어들은 두 번째 링의 시스템에 의존한다:

| 지원 시스템 | 역할 |
| --- | --- |
| 프로젝트 지침 | 저장소 규칙, 빌드/테스트 명령, 도메인 규칙 |
| Tool과 MCP | 저장소, 셸, 웹, 외부 시스템 접근 |
| Ask-user 프로토콜 | 구조화된 운영자 질문, 승인, 기본값, 답변 출처 |
| Git과 worktree | 격리, 복구, 안전한 병렬 작업 |
| Memory와 skill | 지속적인 절차, 재사용 가능한 지식, 반복 context |
| Hook과 briefing | 생명주기 자동화와 context 압축 |
| 검증기 | 생성 후 객관적인 통과/실패 신호 |
| 백그라운드 워커 | 분리된 장기 실행 |
| Resource scheduler | provider, 검색, 쓰기, 검증 동시성 제어 |
| Cost budget | session당 비용 추적, 경고 임계값, 강제 중단 |
| Benchmark | 병렬 작업 실행, 멀티 모델 비교, 실패 분류 |

## 현재 ddudu 분해

그 레이어들 안에서, `ddudu`는 현재 몇 가지 명시적인 runtime 경계로 분할되어 있다:

- `RequestEngine`은 직접 모델 루프, tool 턴, 재시도, provider session 처리를 소유한다
- `RoutingCoordinator`는 직접 vs 위임 vs 팀 결정과 계획 인터뷰 게이팅을 소유한다
- `ResearchRuntime`은 항목별 외부 리서치를 위한 경량 팬아웃과 합성을 소유한다
- `WorkflowStateStore`는 정규 워크플로우 스냅샷, session 복원, mode 메타데이터 복구를 소유한다
- `TeamExecutionCoordinator`는 팀 계획 구체화, 전문가 오케스트레이션, 실시간 진행 요약을 소유한다
- `BackgroundCoordinator`와 백그라운드 실행 서비스는 분리된 job 생명주기와 공유 포그라운드/백그라운드 실행 경로를 소유한다
- `NativeBridgeController`는 전체 실행 모델을 소유하는 대신 UI 이벤트를 runtime 경계에 바인딩하는 어댑터로 남는다

그 경계들 아래에서, 두 개의 일반 커널이 mode 이름보다 더 중요해졌다:

- `ExecutionScheduler`는 provider 호출, 검색 집약적 작업, 쓰기, 검증에 걸쳐 공유 동시성 정책을 소유하며, 스케줄링 핫 패스에서 파일시스템 I/O 없이 인메모리 semaphore 큐를 사용한다
- `TeamOrchestrator`는 의존성 인식 병렬 실행을 소유하며 이제 고정된 웨이브 대신 새로 준비된 워커를 지속적으로 스케줄링한다

이것이 중요한 이유는 오케스트레이션 버그가 보통 경계 버그이기 때문이다.
라우팅, 실행, state, 분리된 생명주기가 하나의 컨트롤러 파일에 살기를 멈추면 시스템이 더 이해하기 쉬워진다.

## 경계 규칙

특히 중요한 경계들이 있다:

### 안정적인 것 vs 동적인 것

- 안정적인 규칙은 커널 prompt 또는 프로젝트 지침 레이어에 속한다
- 빠르게 변하는 정보는 runtime 스냅샷과 지속 state에 속한다

### 정책 vs prompt

- 신뢰 정책은 runtime 강제에 속한다
- 모델이 텍스트를 기억하는 것에 의존해서는 안 된다
- 실행 오버헤드도 정책에 속해야 한다
- "빠르게 가라" 또는 "이것을 병렬화하라"와 같은 임시 prompt 문구에 의존해서는 안 된다

### 페르소나 vs 정책

- mode 레이블은 유용한 운영자 약어다
- 실행 정책은 여전히 context 깊이, 격리, 동시성, 검증 티어와 같은 일반적인 노브로 표현되어야 한다

### 상호작용 vs 텍스트

- 운영자 질문은 타입화된 prompt state로 모델링되어야 한다
- 승인과 확인은 임시 자유 형식 transcript 텍스트 안에 숨겨져서는 안 된다
- 질문 종류, 유효성 검사, 기본값, 답변 출처는 UI 추측이 아니라 harness 계약에 속한다

### Transcript vs artifact

- 긴 채팅 기록은 나쁜 핸드오프 단위다
- 타입화된 artifact가 더 나은 핸드오프 단위다

## 실패 모드

일반적인 아키텍처 실패들:

1. `monolithic prompt syndrome`
   모든 것이 더 많은 prompt 텍스트를 추가함으로써 해결된다.

2. `transcript-as-state`
   지속 state가 직접 모델링되는 대신 채팅에서 재구성된다.

3. `untyped delegation`
   정의된 결과물 없이 작업이 위임된다.

4. `policy leakage`
   안전과 신뢰가 prompt 안에 있을 것으로 기대된다.

5. `UI compensating for architecture`
   시스템 state가 충분히 명시적이지 않기 때문에 인터페이스가 노이즈 많아진다.

## ddudu 입장

`ddudu`는 의도적으로 중간 레이어에서 가장 강하다:

- 정규 session 소유권
- 오케스트레이션
- 분리된 job
- 검증
- context 선택
- scheduler와 정책을 통한 실행 오버헤드 제어
- 운영자에게 보이는 워커 state

의도는 provider runtime을 대체하는 것이 아니다.
더 효과적으로 조정하는 것이다.

중요한 편향은 "더 많은 agent를 사용하라"가 아니다.
"진행할 수 있는 가장 작은 실행 단위를 시작하고, 처리량이나 신뢰를 높일 때만 오케스트레이션을 추가하라"다.

## 이것이 중요한 이유

같은 모델이 다음에 따라 극적으로 다르게 느껴질 수 있다:

- 누가 state를 소유하는지
- context가 어떻게 선택되는지
- 복구 루프가 어떻게 구조화되는지
- 신뢰가 어떻게 강제되는지
- 실행 중에 시스템이 얼마나 가시적인지

그것이 harness 아키텍처가 prompt 민간 전승이 아니라 아키텍처로 문서화될 가치가 있는 이유다.
