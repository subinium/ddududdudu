# Delegation And Artifacts

## Scope

This document covers how a harness should split work across workers and how those workers should exchange results.

## Philosophy

Delegation is not primarily about having more agents.
It is about reducing context load, isolating risk, and making repair loops composable.

That means delegation should be evaluated as a systems optimization, not as a novelty feature.

## Goals

- reduce context load on each worker
- isolate risk where useful
- preserve deliverable quality
- keep review, repair, and apply loops composable

## When Delegation Helps

Delegation helps when it:

- reduces active context size
- separates roles cleanly
- creates safer isolation boundaries
- improves verification or review quality

Delegation hurts when it:

- splits simple tasks for no reason
- copies large parent transcripts into every child
- returns generic prose instead of structured deliverables

In short:

- delegation should compress complexity
- it should not amplify it

## Research Fan-Out

Comparison and research prompts often benefit from a task-shaped split.

If the operator asks for `A/B/C` research, the useful decomposition is usually:

- one read-only worker per subject
- a lead or synthesis step only after those workers finish

That is much more effective than a single "research" worker serially checking every subject while the UI claims the task is parallel.

## Deliverable-Driven Delegation

Before delegating, define:

- objective
- expected deliverable
- success criteria
- bounded context

This is significantly more reliable than "go figure it out".

It also makes retries and comparison across providers easier.

## Typed Artifacts

Useful artifact kinds include:

- `plan`
- `review`
- `patch`
- `briefing`
- `design`
- `research`

Useful artifact fields include:

- purpose
- files
- findings
- risks
- verification status
- next steps

Typed artifacts reduce prompt bloat because they let the harness hand off decisions instead of replaying conversation.

## Checklists And Progress

Long-running delegated work is easier to trust when it is represented as visible work items.

A useful checklist shows:

- pending
- active
- done
- failed
- blocked
- owning worker

This is more actionable than a generic "agent running" indicator.

## Selective Isolation And Verification

Not every delegated task should pay the same execution overhead.

Useful defaults are:

- isolated worktrees for write-capable or risky execution
- verification loops for workers that are expected to change or validate code
- no worktree and no verification by default for read-only research workers

Otherwise the harness spends most of its time paying orchestration tax instead of making progress.

## Review And Repair Loops

Delegation becomes much more valuable when tied to verification.

A useful loop is:

1. plan
2. execute
3. verify
4. repair
5. escalate if repair fails
6. apply or report

That loop often matters more than the initial generation quality.

## Failure Modes

Typical multi-agent failures:

1. `delegation by default`
   Everything is split regardless of task shape.

2. `role drift`
   A worker receives a label but no real contract.

3. `artifact collapse`
   The system claims typed handoffs but really only stores summaries.

4. `invisible ownership`
   The operator cannot tell which worker is tied to which todo.

## ddudu Implementation Notes

Current `ddudu` already uses:

- mode-aware delegation
- detached background jobs
- selective worktree isolation
- typed artifacts
- verifier → repair → escalate → apply flow
- itemized research fan-out
- worker-visible ownership and live heartbeats

The next maturity step is usually tighter artifact discipline, not more subagents.

## Design Rule

Workers should exchange decisions, evidence, and deliverables.
They should not rely on transcript replay as the primary handoff mechanism.
