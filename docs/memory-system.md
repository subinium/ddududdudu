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

## Backend Modularity

The storage format should not be the same thing as the memory contract.

`ddudu` should therefore treat memory as a backend interface with swappable implementations.

That means callers should depend on operations such as:

- load scopes
- save scope
- append entry
- clear scope

They should not depend directly on path layout or file mutation details.

### Why this matters

A file backend is a good default because it is transparent and durable.

But future backends may want to provide:

- vector-backed semantic retrieval
- QMD-backed knowledge lookup
- remote team memory stores
- encrypted local stores

If memory is hard-coded to one storage method, each of those experiments becomes a core refactor instead of a backend swap.

### ddudu direction

`ddudu` should keep:

- a stable memory API
- a configurable backend selection point
- file storage as the default baseline

That keeps the system simple today while leaving room for optional higher-level memory engines later.

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

## Promotion 2.0

Promotion is now a scored pipeline rather than a hard-coded append.

Implementation: `src/core/memory-promotion.ts`

### Candidate extraction

For each successful run, the system derives candidate records from:

- verification summary
- changed files
- artifact payload
- apply summary
- repeated command patterns

### Scoring dimensions

Each candidate is scored on five dimensions with weighted composite:

| Dimension | Weight | Signal |
| --- | --- | --- |
| stability | 0.25 | verification passed AND content references specific files/patterns |
| reuse | 0.30 | content describes a convention, build command, or architectural rule |
| specificity | 0.15 | content contains file paths, command names, or concrete values |
| verification | 0.20 | 1.0 if passed, 0.3 if skipped, 0.0 if failed |
| novelty | 0.10 | 1.0 if no existing entry has >60% text overlap |

### Promotion decision

The composite score drives the promotion target:

- `promote_semantic` when composite >= 0.7 AND stability >= 0.6 AND verification >= 0.5
- `promote_procedural` when composite >= 0.6 AND content has command/workflow patterns
- `promote_episodic` when composite >= 0.4 AND composite < 0.7
- `keep_working` when verification < 0.3 (unverified)
- `discard` when composite < 0.3

### Confidence metadata

Promoted entries now carry YAML frontmatter with confidence metadata:

```yaml
---
confidence: 0.85
sourceRunId: "abc123"
promotedAt: "2026-03-11T12:00:00Z"
score: { stability: 0.9, reuse: 0.8, specificity: 0.7, verification: 1, novelty: 0.6, composite: 0.82 }
---
```

This metadata is optional and additive — existing memory files without frontmatter continue to work unchanged.

## Dedupe And Merge

Memory quality degrades quickly without dedupe.

The promotion pipeline supports:

- fuzzy dedupe by Jaccard similarity on normalized word sets (duplicate threshold: >0.7 overlap)
- merge-on-similarity for entries with 0.5-0.7 overlap, preferring more specific content
- replacement when a candidate scores higher than an existing entry older than 7 days

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

Current implementation supports:

- scoped memory files
- purpose-aware memory selection
- basic semantic/procedural promotion after verified apply
- scored promotion candidates (Promotion 2.0)
- Jaccard-based dedupe and merge policy
- confidence metadata as YAML frontmatter on promoted entries

What it does not yet provide:

- a memory inspector that explains why an entry was promoted
- automatic wiring of the scored pipeline into the verification flow (wiring pending)

## Design Rule

Memory should preserve reusable operational knowledge, not accumulate narrative residue.
