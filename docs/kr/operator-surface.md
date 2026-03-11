# Operator Surface

## 범위

이 문서는 coding harness의 사용자 대면 제어 표면을 다룬다.

`ddudu`에서는 주로 native TUI가 이에 해당하지만, 설계 원칙은 어떤 operator 인터페이스에도 적용된다.

## 철학

UI는 제어 플레인의 일부다.

harness가 다음을 할 수 있게 되면:

- 작업 큐잉
- job 분리
- worker 위임
- 실패 수리
- patch 적용

인터페이스는 더 이상 장식이 아니다.
trust 모델의 일부가 된다.

## 핵심 목표

operator surface는 harness를 읽기 쉽게 만들어야 한다.

완전한 IDE를 흉내 낼 필요는 없다.
올바른 질문에 빠르게 답할 수 있으면 된다.

## UI가 답해야 할 질문들

언제든지 operator는 다음을 파악할 수 있어야 한다:

- 지금 무엇이 실행 중인가
- 무엇이 큐에 있는가
- 무엇이 차단되어 있는가
- 작업이 대기 중일 때 병목 리소스가 무엇인가
- 이미 완료된 것이 무엇인가
- 어떤 worker가 어떤 task를 담당하는가
- 검증이 통과했는가
- harness가 정책 또는 사용자 입력을 기다리고 있는가
- harness가 어떤 종류의 답변을 요청하는가
- 기본으로 선택되거나 권장되는 옵션이 무엇인가
- 커스텀 입력이 허용되는지, 그리고 답변이 거부된 이유가 무엇인가

이것들이 불명확하면, 기반 시스템이 기술적으로 올바르더라도 신뢰가 무너진다.

## 일반적인 실패 패턴

### Transcript 과부하

증상:

- 도구 로그가 메인 transcript를 가득 채운다
- 내부 상태 메시지가 실제 답변을 밀어낸다

### 숨겨진 상태

증상:

- 큐가 composer 안에 숨어 있다
- worker가 가시적인 ownership 없이 실행된다
- background job이 존재하지만 재개 가능한 느낌이 없다

### 약한 진행 신호

증상:

- 스피너만 보인다
- task 구조가 암묵적이다
- 검증 상태가 지연되거나 불투명하다

### 장식적 밀도

증상:

- 너무 많은 chrome
- 가치 낮은 상태 행이 너무 많다
- 구현 세부사항이 first-class 공간을 차지한다

효과:

- 시스템이 더 강력해질수록 중요한 상태를 스캔하기가 오히려 어려워진다

## 정보 계층

고신호 상태가 먼저 나타나야 한다:

1. 현재 실행 (current run)
2. git status (브랜치, 변경된 파일, staged/unstaged)
3. todo 보드
4. 실행 체크리스트 (run checklist)
5. worker와 ownership
6. 분리된 job (detached jobs)
7. 큐 (queue)
8. context와 시스템

저신호 내부 정보는 inspector, palette, 또는 명시적인 보조 표면으로 밀어내야 한다.

예시:

- 원시 provider 노트
- 긴 도구 히스토리
- 전체 주입된 context 덤프
- 반복되는 페르소나 또는 모델 정보
- 요청하지 않은 전체 diff

이 계층은 장식이 아니다.
operator 주의를 우선순위화하는 것이다.

## 인터랙션 표면

UI의 각 영역은 서로 다른 종류의 정보를 담아야 한다:

- 메인 transcript는 사용자에게 보이는 답변과 고수준 진행 상황을 보여줘야 한다
- side rail은 실행 상태, todo, worker ownership, detached job, 큐, context, 시스템을 보여줘야 한다
- composer는 일반 프롬프트 뒤에 숨기지 않고 typed ask-user 질문을 직접 표시해야 한다

이 역할들이 뒤섞이면, 모델이 기술적으로 여전히 작동하더라도 operator는 신뢰를 잃는다.

## Ask-User 표면

인터랙티브 질문도 제어 플레인의 일부다.

유용한 ask-user 표면은 operator가 추론하지 않아도 다음을 명확히 보여줘야 한다:

- 질문 종류 (confirm, single-select, input, number, path 등)
- 답변이 필수인지 여부
- 기본 답변 또는 기본 선택지
- 권장되거나 위험한 옵션
- 유효성 검사 기대값
- 제출된 답변이 선택지에서 고른 것인지 자유 입력인지

이것이 가장 중요한 경우:

- permission 프롬프트
- 파괴적 확인
- session 및 resume picker
- 실행 중 구현 트레이드오프 명확화

## 진행 모델

유용한 operator surface는 다음을 구분한다:

- active
- pending
- completed
- failed
- blocked on approval

이 구조가 일반적인 활동 표시기보다 훨씬 신뢰할 수 있다.

## ddudu 구현 노트

`ddudu`는 현재 다음에 의존한다:

- 실행 체크리스트와 분리된 공유 todo 보드
- 위임된 및 도구 기반 subagent에 대한 worker-task 매핑
- 장기 실행 작업이 조용해질 때의 heartbeat 요약
- detached job 상태
- 큐 가시성
- 유효성 검사 힌트와 명시적 선택 메타데이터가 있는 composer의 typed ask-user 프롬프트
- 엄격한 확인을 위한 숫자 단축키와 기본 선택 처리
- 반복되는 provider 정보 대신 context/시스템 요약
- 검색 또는 검증 경합 같은 스케줄러 압력을 반영할 수 있는 실행 및 대기 세부 정보
- transcript에서 muted 스타일의 인라인 tool call 렌더링 (✓/✗/spinner 상태 아이콘, opencode의 `text-weak` 패턴과 유사)
- footer 바의 색상 코딩된 context 미터 (일반 → 60%에서 주황 → 80%에서 빨강)
- 즉각적인 시각 피드백을 위한 delta streaming 파이프라인 (~80바이트 이벤트, 깜빡이는 커서, 실시간 토큰 카운터)
- dimmed reasoning 텍스트와 함께하는 thinking breathing 애니메이션

비어 있는 sidebar 섹션 (유휴 worker, 빈 todo 보드)은 장식적 밀도를 줄이기 위해 숨긴다.
Git status (브랜치, 변경된 파일, staged/unstaged 수)는 이제 first-class sidebar 섹션으로 표시된다.
sidebar context rail은 footprint 퍼센트, 시각적 미터 바, 토큰 수를 표시한다.

장기적인 품질 기준은 "더 많은 패널"이 아니다.
"ownership, 대기 이유, 완료 상태에 대한 모호함 감소"다.

## 제어 편향

side rail은 모델 정체성이 아닌 실행 진실에 편향되어야 한다.

즉:

- task ownership이 어떤 페르소나 레이블이 생성했는지보다 중요하다
- 검증 상태가 유창한 중간 텍스트보다 중요하다
- 대기 이유가 일반 스피너보다 중요하다
- 하나의 공유 context 요약이 여러 곳에서 동일한 runtime 정체성을 반복하는 것보다 유용하다

## 설계 원칙

operator surface는 ownership, 진행 상황, 리스크를 숨기지 않으면서 복잡성을 압축해야 한다.
