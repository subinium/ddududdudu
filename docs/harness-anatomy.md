# Harness Anatomy

## Scope

This document describes the major architectural layers in a coding harness and the boundaries between them.

It is not a command reference.
It is a decomposition of responsibility.

## Philosophy

A coding harness should be designed as a layered system.

That framing matters because many failures in AI coding tools are actually boundary failures:

- dynamic state encoded in prompts
- trust encoded in prose instead of policy
- delegation without explicit contracts
- UI compensating for state that was never modeled properly

## Layer Model

| Layer | Primary responsibility | Typical failure if weak |
| --- | --- | --- |
| Execution kernel | provider runtime, tool execution, permissions, transport | unsafe or inconsistent execution |
| Context engine | retrieval, prompt assembly, compaction, memory loading | noisy, slow, or under-informed decisions |
| Session/state layer | canonical transcript, artifacts, jobs, checkpoints, provider state | brittle continuity and weak recovery |
| Orchestration layer | routing, delegation, verification, escalation, repair | wasted tokens or overloaded workers |
| Operator surface | visibility, inspection, progress, recovery UX | low trust and poor delegatability |

## Ownership Model

Each layer should own a narrow class of concerns.

| Layer | Should own | Should not own |
| --- | --- | --- |
| Execution kernel | runtime calls, tool invocation, permission enforcement | long-term project memory, UI state |
| Context engine | prompt selection, retrieval, compaction, memory selection | final authority over execution policy |
| Session/state layer | durable task state, transcripts, artifacts, jobs | provider-specific hidden prompt behavior |
| Orchestration layer | routing, delegation, repair flows, escalation | low-level transport details |
| Operator surface | observability and control | source of truth for the actual work |

When these boundaries collapse, complexity rises quickly.

## Supporting Systems

The core layers depend on a second ring of systems:

| Supporting system | Role |
| --- | --- |
| Project instructions | repo conventions, build/test commands, domain rules |
| Tools and MCP | access to repo, shell, web, and external systems |
| Ask-user protocol | structured operator questions, approvals, defaults, and answer provenance |
| Git and worktrees | isolation, recovery, safe parallel work |
| Memory and skills | persistent procedures, reusable knowledge, repeated context |
| Hooks and briefings | lifecycle automation and context compression |
| Verifiers | objective pass/fail signals after generation |
| Background workers | detached and long-running execution |
| Resource scheduler | provider, search, write, and verification concurrency control |
| Cost budget | per-session cost tracking, warning thresholds, hard-stop enforcement |
| API resilience | retry with exponential backoff, error classification, transient failure recovery |
| Result augmentation | rule-based behavioral nudges injected after tool calls to improve model self-correction |
| Benchmarks | parallel task execution, multi-model comparison, failure categorization |

## Current ddudu Decomposition

Inside those layers, `ddudu` is currently split into a few explicit runtime boundaries:

- `RequestEngine` owns the direct model loop, tool turns, retries, and provider session handling
- `RoutingCoordinator` owns direct vs delegate vs team decisions and planning-interview gating
- `ResearchRuntime` owns lightweight fan-out and synthesis for itemized external research
- `WorkflowStateStore` owns canonical workflow snapshots, session restore, and mode metadata recovery
- `TeamExecutionCoordinator` owns team plan materialization, specialist orchestration, and live progress summaries
- `BackgroundCoordinator` plus the background execution service own detached job lifecycle and the shared foreground/background execution path
- `NativeBridgeController` remains the adapter that binds UI events to runtime boundaries instead of owning the whole execution model

Under those boundaries, two generic kernels now matter more than mode names:

- `ExecutionScheduler` owns shared concurrency policy across provider calls, search-heavy work, writes, and verification, using an in-memory semaphore queue (no filesystem I/O on the scheduling hot path)
- `TeamOrchestrator` owns dependency-aware parallel execution and now schedules newly-ready workers continuously instead of in fixed waves

This matters because orchestration bugs are usually boundary bugs.
The system becomes easier to reason about once routing, execution, state, and detached lifecycle stop living in one controller file.

## Boundary Rules

Some boundaries are especially important:

### Stable vs dynamic

- stable rules belong in the kernel prompt or project instruction layer
- fast-changing information belongs in runtime snapshots and durable state

### Policy vs prompt

- trust policy belongs in runtime enforcement
- it should not depend on the model remembering prose
- execution weight should also belong in policy
- it should not depend on ad hoc prompt phrasing like "go fast" or "parallelize this"

### Persona vs policy

- mode labels are useful operator shorthand
- execution policy should still be expressed in generic knobs such as context depth, isolation, concurrency, and verification tier

### Interaction vs prose

- operator questions should be modeled as typed prompt state
- approval and confirmation should not be hidden inside ad hoc free-form transcript text
- question kind, validation, defaults, and answer provenance belong to the harness contract, not to UI guesswork

### Transcript vs artifacts

- long chat history is a poor handoff unit
- typed artifacts are better handoff units

## Failure Modes

Common architecture failures:

1. `monolithic prompt syndrome`
   Everything is solved by adding more prompt text.

2. `transcript-as-state`
   Durable state is reconstructed from chat instead of modeled directly.

3. `untyped delegation`
   Work is delegated without defined deliverables.

4. `policy leakage`
   Safety and trust are expected to live inside the prompt.

5. `UI compensating for architecture`
   The interface becomes noisy because system state is not explicit enough.

## ddudu Position

`ddudu` is intentionally strongest in the middle layers:

- canonical session ownership
- orchestration
- detached jobs
- verification
- context selection
- execution-weight control through scheduler and policy
- operator-visible worker state

The intent is not to replace provider runtimes.
The intent is to coordinate them more effectively, recover from their failures more gracefully, and shape their behavior more precisely.

The important bias is not "use more agents".
It is "start the smallest executable unit that can make progress, nudge the model toward verification, and add orchestration only when it increases throughput or trust".

## Why This Matters

The same model can feel dramatically different depending on:

- who owns state
- how context is selected
- how repair loops are structured
- how trust is enforced
- how visible the system is while it runs

That is why harness architecture deserves to be documented as architecture, not as prompt lore.
