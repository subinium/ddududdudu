# Memory System

## Scope

This document covers how `ddudu` treats memory as a subsystem rather than as a single text file.

The goal is not to "store more notes".
The goal is to preserve information that improves future execution while keeping prompt payloads bounded.

## Design Position

`ddudu` treats memory as a write path, a retrieval path, and a promotion policy.

Those are separate concerns:

- write path: how observations enter memory
- retrieval path: which memory is selected for a request
- promotion policy: which transient observations become durable knowledge

If these are collapsed into one bucket, memory quickly becomes noisy and expensive.

## Goals

- preserve useful project and operator knowledge across sessions
- keep short-term work state separate from long-lived guidance
- promote only information that improves future task completion
- keep retrieval purpose-aware and bounded

## Non-goals

- replaying full session history as memory
- using memory as a generic transcript archive
- promoting every successful run into durable knowledge
- letting memory replace verification or repo inspection

## Memory Layers

`ddudu` currently models memory as multiple scopes:

| Scope | Role | Expected lifetime |
| --- | --- | --- |
| `global` | operator-wide defaults and reusable personal preferences | long-lived |
| `project` | stable repository-specific conventions | long-lived |
| `working` | active task state that should survive across a short burst of work | short-lived |
| `episodic` | compact summaries of notable past runs | medium-lived |
| `semantic` | facts about the codebase or workflow that are likely to be reused | long-lived |
| `procedural` | repeated instructions or execution recipes | long-lived |

The important point is that these layers decay at different speeds and should not be retrieved together by default.

## Storage Model

Current file layout:

- `~/.ddudu/memory.md` for global memory
- `.ddudu/memory.md` for project memory
- `.ddudu/memory/working.md`
- `.ddudu/memory/episodic.md`
- `.ddudu/memory/semantic.md`
- `.ddudu/memory/procedural.md`

This layout is intentionally simple and durable.
The complexity lives in selection and promotion, not in storage format.

## Retrieval Policy

Memory retrieval should be purpose-aware.

Recommended defaults:

| Purpose | Preferred scopes |
| --- | --- |
| execution | `working`, `semantic`, `procedural` |
| planning | `project`, `semantic`, `procedural` |
| review | `episodic`, `semantic`, `project` |
| design | `semantic`, `procedural`, `working` |
| general | `project`, `semantic`, `procedural` |

This is why `ddudu` selects memory scopes per request rather than injecting all memory every turn.

## Promotion Model

Promotion should be explicit enough to be explainable and selective enough to avoid junk growth.

### Promotion candidates

Good candidates:

- verified fixes that encode a repo-specific rule
- repeated command sequences that become a stable procedure
- durable repo conventions discovered during repeated work
- high-confidence architectural facts that are likely to matter again

Bad candidates:

- raw conversation summaries
- one-off debugging notes
- vague style preferences with no evidence
- unverified claims about the codebase

### Current ddudu behavior

Today `ddudu` does a minimal promotion pass after successful verified applies:

- semantic memory gets a short "what changed / what verified / why it matters" entry
- procedural memory gets a short "how to repeat this workflow" entry when applicable

This is intentionally conservative.

## Proposed Promotion 2.0

The next step should treat promotion as a scored pipeline rather than a hard-coded append.

### Candidate extraction

For each successful run, derive candidate records from:

- verification summary
- changed files
- artifact payload
- apply summary
- repeated command patterns

### Scoring dimensions

Each candidate should be scored on:

- stability: is this likely to stay true?
- reuse: will future tasks benefit from retrieving it?
- specificity: is it concrete enough to act on?
- verification: was it confirmed by checks or just inferred?
- novelty: is it already represented in memory?

### Promotion decision

Example rule:

- promote to `semantic` when stability + verification + reuse are high
- promote to `procedural` when the output encodes a reusable sequence
- promote to `episodic` when the result is useful context but not a stable rule
- keep in `working` when it is still in-flight or uncertain

## Dedupe And Merge

Memory quality degrades quickly without dedupe.

Promotion 2.0 should therefore support:

- fuzzy dedupe by normalized text and file overlap
- merge-on-similarity for repeated procedures
- replacement when a new verified rule supersedes an older weak one

Without this, memory turns into append-only clutter.

## Failure Modes

### Memory dump retrieval

All scopes are injected at once.

Effect:

- prompt growth
- duplicated guidance
- stale rules overpowering active task state

### Promotion without verification

The system stores conclusions that were never checked.

Effect:

- false confidence
- sticky misinformation

### Procedural overfitting

One successful command sequence is promoted as a universal rule.

Effect:

- future misuse
- brittle automation

### Working-memory leakage

Short-lived task state stays around too long.

Effect:

- stale context
- irrelevant retrieval

## ddudu Implementation Notes

Current implementation already supports:

- scoped memory files
- purpose-aware memory selection
- basic semantic/procedural promotion after verified apply

What it does not yet provide:

- scored promotion candidates
- dedupe or merge policy
- memory confidence metadata
- a memory inspector that explains why an entry was promoted

## Design Rule

Memory should preserve reusable operational knowledge, not accumulate narrative residue.
