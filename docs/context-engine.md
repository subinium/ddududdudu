# Context Engine

## Scope

This document covers how a harness decides what enters a model request.

The problem is not "how to fit more context".
The problem is "how to maximize signal for the next decision".

## Philosophy

Context quality matters more than context volume.

Poor context can make a strong model behave weakly.
Good context can make the same model behave materially better.

That is why context engineering should be treated as a query-planning problem, not as transcript accumulation.

## Goals

- keep prompt payloads high-signal
- preserve continuity without replaying everything
- support multiple worker types and provider runtimes
- reduce retries caused by missing or noisy context

## Non-goals

- blindly minimizing token count
- replaying full transcript history by default
- treating every instruction source as equally important

## Context Layers

`ddudu` separates context into distinct layers:

| Layer | Content | Expected stability |
| --- | --- | --- |
| Stable kernel | operating rules for tool use, verification, delegation, trust | very stable |
| Project instruction layer | `.ddudu/DDUDU.md`, rules, prompts, compatible instruction files | stable within a repo |
| Memory layer | selected working, semantic, procedural, or episodic memory | semi-stable |
| Request snapshot | relevant files, artifacts, changed files, todo state, active jobs | highly dynamic |
| Provider session layer | provider-specific session continuity | runtime-specific |

This matters because each layer decays at a different speed.

## Failure Modes

### Transcript inflation

Symptoms:

- replaying full conversations for narrow tasks
- sending whole-file context for line-local edits
- hydrating provider sessions with prose instead of structured artifacts

Effect:

- more latency
- more distraction
- weaker next-step decisions

### Instruction sprawl

Symptoms:

- too many instruction sources merged without priority
- duplicated rules in prompts, docs, memory, and snapshots

Effect:

- the model is not guided; it is saturated

### Boilerplate retrieval

Symptoms:

- raw HTML instead of readable content
- generated files outranking source files
- unchanged files dominating active-change work

Effect:

- high token volume with low task relevance

### Wrong layer placement

Symptoms:

- dynamic state encoded into the system prompt
- durable project rules stuffed into request snapshots
- provider session reuse treated as the only continuity mechanism

Effect:

- brittle context growth and hard-to-debug behavior

## Design Heuristics

Prefer:

- file ranges over full files
- symbol-based reads over generic reads
- typed artifacts over transcript replay
- purpose-aware memory selection over full memory dumps
- changed-files-first ranking for active code changes
- readable extraction over raw document payloads unless fidelity is required

When in doubt, prefer narrower context with stronger evidence.

## Compaction Rule

Good compaction preserves:

- decisions
- blockers
- verification outcomes
- next-step handoff state

Bad compaction preserves:

- vague summary prose
- low-entropy transcript paraphrases

Typed artifacts are especially valuable here because they preserve operational meaning rather than narrative summary.

## Performance Principle

The target metric is not "smallest prompt".

The target metric is:

- minimum context required to avoid avoidable retries
- maximum signal for the next action

That is a context quality problem, not a context size problem.

## ddudu Implementation Notes

Current `ddudu` leans on:

- a slim stable kernel prompt
- purpose-aware artifact selection
- purpose-aware memory selection
- task-type-specific request snapshots
- compaction plus provider `resume` and `hydrate`

The main tuning surface is no longer "add more prompt".
It is "select better context".
