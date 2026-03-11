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

- execution-shape classification before heavyweight retrieval when the task shape is obvious
- file ranges over full files
- symbol-based reads over generic reads
- typed artifacts over transcript replay
- purpose-aware memory selection over full memory dumps
- changed-files-first ranking for active code changes
- readable extraction over raw document payloads unless fidelity is required

When in doubt, prefer narrower context with stronger evidence.

## Compaction

### Design Rule

Good compaction preserves:

- decisions
- blockers
- verification outcomes
- next-step handoff state

Bad compaction preserves:

- vague summary prose
- low-entropy transcript paraphrases

Typed artifacts are especially valuable here because they preserve operational meaning rather than narrative summary.

### Two-Phase Pipeline

`ddudu` compaction runs in two phases:

1. **Prune** — walk backwards through the conversation, protect the most recent N turns, and aggressively clip old tool outputs down to their status lines. This phase is free (pure string manipulation) and reduces the conversation to a size the summarizer can process efficiently.
2. **LLM summarize** — send the pruned conversation to the active model with a structured template. The model produces a summary with explicit sections: Goal, Instructions, Discoveries, Accomplished, In Progress, Remaining, Relevant Files, Active Context.

The result is prefixed with a continuation header that tells the next agent to build on existing work rather than duplicate it.

If no provider is authenticated or the LLM call fails, compaction falls back to a legacy string-clip approach so the system never breaks.

### Why LLM-Powered

String-clipping compaction (220-character message truncation) destroys context quality. Key decisions, file paths, and progress state are lost. LLM-powered compaction produces a structured document that another agent can actually continue from, similar to how opencode and Codex CLI handle compaction.

## Execution-Shape-First Retrieval

Context cost should follow execution shape, not only request length.

When the prompt is mostly asking for comparison, research, or fact-finding outside the repo, a good harness should:

- route the request before building a heavyweight code snapshot
- skip relevant-file retrieval and changed-file scans unless the repo is clearly part of the question
- keep artifact carry-over small
- avoid loading broad memory or planning state that does not improve the next search decision

Likewise, focused implementation work should not automatically pay repo-wide orchestration or planning costs.

If one owner can start with a narrow code slice, a good harness should prefer:

- focused file and artifact retrieval
- direct or single-owner delegated execution
- lightweight scout context before managed team context

This is one of the easiest ways to cut latency without weakening answer quality.

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
- lightweight snapshots for external research
- route-before-snapshot for obvious direct, delegation, team, and research cases
- two-phase LLM-powered compaction (prune then structured summary)
- delta streaming pipeline (~80-byte events instead of full-state JSON) for real-time feedback
- provider `resume` and `hydrate` for session continuity

The main tuning surface is no longer "add more prompt".
It is "select better context".
