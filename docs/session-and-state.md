# Session And State

## Scope

This document covers how a harness preserves continuity across turns, workers, and provider runtimes.

## Philosophy

Users experience work as continuous.
Model runtimes usually do not.

If a harness wants to support:

- long-running tasks
- background jobs
- retries
- forks
- provider switches

then continuity has to be modeled explicitly rather than inferred from a transcript.

## Goals

- keep one durable source of truth for the work
- allow provider-specific reuse without losing canonical state
- support detached work, retries, handoffs, and recovery
- keep work inspectable after the foreground request ends

## State Model

### Canonical session

The harness-owned session is the durable record for:

- user and assistant turns
- artifacts
- plan state
- checkpoints
- background work
- verification outcomes

This is the authoritative state.

### Provider session

Provider-specific sessions are execution caches:

- lower prompt overhead
- preserve provider-native continuity
- improve runtime reuse

They are not the only durable truth of the task.

### Workspace state

For delegated work, workspace state needs its own boundary:

- main workspace
- isolated worktree
- detached background workspace

This is operational state, not just prompt state.

## First-Class State Objects

At minimum, a harness should model:

- transcript
- current worker or mode
- todo and plan state
- verification state
- detached jobs
- recent artifacts
- workspace identity

If these only exist as prose inside chat, the system becomes fragile and difficult to inspect.

## Isolation Notes

Git worktrees are a useful middle layer:

- safer than editing the main workspace directly
- lighter than a VM or container
- practical for repair and review loops

They should not be confused with a full sandbox.

## Recovery Questions

A useful state layer should answer:

1. can a session be reopened?
2. can a provider runtime be resumed or rehydrated?
3. can a failed job be retried without replaying everything?
4. can an isolated result be applied back safely?

If the answer is no, the harness is still closer to a chat client than an execution system.

## Failure Modes

Common state failures:

1. `provider-owned truth`
   Work disappears when the vendor runtime changes.

2. `transcript-only continuity`
   Resume means replaying text instead of recovering modeled state.

3. `detached work without lifecycle`
   Jobs can start, but not be inspected, retried, or resumed meaningfully.

4. `workspace ambiguity`
   A result exists, but the user cannot tell where it came from or whether it landed.

## ddudu Implementation Notes

Current `ddudu` uses:

- canonical sessions
- provider-backed sessions
- detached background jobs
- git worktree isolation
- resumable checkpoints and handoffs

The design bias is explicit state over transcript reconstruction.

## Design Rule

Use chat to explain work.
Use state to manage work.
