# Session And State

## 범위

이 문서는 harness가 턴, worker, provider runtime 전반에 걸쳐 연속성을 어떻게 보존하는지 다룬다.

## 철학

사용자는 작업을 연속적인 것으로 경험한다.
모델 runtime은 보통 그렇지 않다.

harness가 다음을 지원하려면:

- 장기 실행 작업
- background job
- 재시도
- fork
- provider 전환

연속성은 transcript에서 추론하는 게 아니라 명시적으로 모델링되어야 한다.

## 목표

- 작업에 대한 하나의 지속적인 기준 상태 유지
- 정규 상태를 잃지 않고 provider별 재사용 지원
- 분리된 작업, 재시도, handoff, 복구 지원
- foreground 요청이 끝난 후에도 작업을 검사 가능하게 유지

## Global-First 기본값

운영자 상태는 운영자가 명시적으로 요청하지 않는 한 하나의 레포 안에 갇혀 있는 것처럼 느껴져서는 안 된다.

따라서 `ddudu`는 다음에 대해 global-first 저장소를 기본값으로 한다:

- 저장된 session
- provider 인증
- 운영자 config
- global memory

프로젝트 로컬 `.ddudu/` 파일은 여전히 중요하지만, 연속성이 존재할 수 있는 유일한 장소가 아닌 명시적인 오버라이드 또는 프로젝트 instruction 레이어로서 역할한다.

## 상태 모델

### Canonical session

harness가 소유하는 session은 다음에 대한 지속적인 기록이다:

- 사용자와 어시스턴트 턴
- artifact
- plan 상태
- checkpoint
- background 작업
- 검증 결과

이것이 권위 있는 상태다.

### Provider session

Provider별 session은 실행 cache다:

- 낮은 prompt 오버헤드
- provider 네이티브 연속성 보존
- runtime 재사용 개선

이것이 작업의 유일한 지속적 기준이 되어서는 안 된다.

### Workspace 상태

위임된 작업의 경우, workspace 상태는 자체 경계가 필요하다:

- 메인 workspace
- 격리된 worktree
- 분리된 background workspace

그 경계는 선택적일 수 있다.
쓰기 지향적이거나 위험한 작업은 격리가 필요할 수 있지만, 읽기 전용 리서치는 종종 worktree 설정을 완전히 건너뛸 수 있다.

이것은 단순한 prompt 상태가 아닌 운영 상태다.

## 1급 상태 객체

최소한 harness는 다음을 모델링해야 한다:

- transcript
- 현재 worker 또는 mode
- todo와 plan 상태
- 검증 상태
- 분리된 job
- worker 활동 스냅샷
- 종류, 기본값, 유효성 검사를 포함한 대기 중인 ask-user prompt 상태
- 최근 artifact
- workspace 식별자

이것들이 채팅 내 텍스트로만 존재한다면, 시스템은 취약해지고 검사하기 어려워진다.

## 격리 노트

Git worktree는 유용한 중간 레이어다:

- 메인 workspace를 직접 편집하는 것보다 안전
- VM이나 컨테이너보다 가벼움
- 수리 및 리뷰 루프에 실용적

보편적인 기본값이 아닌 조건부 도구로 취급하는 게 좋다.

완전한 sandbox와 혼동해서는 안 된다.

## 복구 질문

유용한 상태 레이어는 다음에 답할 수 있어야 한다:

1. session을 다시 열 수 있는가?
2. provider runtime을 resume하거나 rehydrate할 수 있는가?
3. 실패한 job을 모든 것을 재생하지 않고 재시도할 수 있는가?
4. 격리된 결과를 안전하게 다시 적용할 수 있는가?

답이 아니오라면, harness는 여전히 실행 시스템보다 채팅 클라이언트에 가깝다.

## 실패 패턴

일반적인 상태 실패:

1. `provider-owned truth`
   vendor runtime이 변경되면 작업이 사라진다.

2. `transcript-only continuity`
   resume이 모델링된 상태를 복구하는 대신 텍스트를 재생하는 것을 의미한다.

3. `detached work without lifecycle`
   Job을 시작할 수 있지만, 의미 있게 검사하거나 재시도하거나 resume할 수 없다.

4. `workspace ambiguity`
   결과는 존재하지만, 사용자가 어디서 왔는지 또는 제대로 적용됐는지 알 수 없다.

## ddudu 구현 노트

현재 `ddudu`가 사용하는 것:

- `~/.ddudu/` 아래 global-first session 및 config 저장소
- canonical session
- provider 기반 session
- 분리된 background job
- 버전 관리된 workflow 스냅샷
- 실행 안전성을 개선하는 곳에서 git worktree 격리
- 위임된 실행 후 명시적인 worktree 정리
- 임시 터미널 prompt가 아닌 구조화된 ask-user 상태
- resume 가능한 checkpoint와 handoff

설계 편향은 transcript 재구성보다 명시적 상태다.

## 설계 규칙

작업을 설명하는 데는 채팅을 사용한다.
작업을 관리하는 데는 상태를 사용한다.
