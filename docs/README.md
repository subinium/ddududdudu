# ddudu Technical Notes

This directory documents the system design behind `ddudu`.

The top-level [README](../README.md) stays product-facing:

- visible capabilities
- installation
- commands and shortcuts
- supported workflows

This directory is the architecture-facing layer:

- what problem a coding harness is actually solving
- how `ddudu` decomposes that problem
- which tradeoffs belong to which subsystem
- where performance, trust, and operator confidence usually come from
- how durable knowledge should be selected, promoted, and retrieved

## Why These Docs Exist

Most AI coding systems are described as if the model were the main artifact and the harness were a thin wrapper.

That framing is misleading.

In practice, the harness determines:

- which state survives
- which context is selected
- how tools are gated
- when work is delegated
- how failures are repaired
- what the operator can trust while the system is running

These docs exist to make those design decisions explicit.

## Design Position

`ddudu` is built around a few strong positions:

1. the harness matters at least as much as the prompt
2. state is more durable than transcript
3. context quality matters more than context size
4. verification matters more than confident prose
5. trust should be enforced by runtime policy, not just requested in language
6. the UI is part of the control plane, not a cosmetic shell

## Reading Order

| Document | Focus |
| --- | --- |
| [Design Principles](./design-principles.md) | the high-level worldview behind the system |
| [Harness Anatomy](./harness-anatomy.md) | subsystem decomposition, ownership, and boundaries |
| [Context Engine](./context-engine.md) | prompt construction, retrieval, compaction, and context selection |
| [Memory System](./memory-system.md) | memory scopes, promotion policy, retrieval boundaries, and failure modes |
| [Session And State](./session-and-state.md) | canonical sessions, provider sessions, jobs, workspaces, durable state |
| [Delegation And Artifacts](./delegation-and-artifacts.md) | delegation contracts, typed handoffs, review and repair loops |
| [Trust And Sandbox](./trust-and-sandbox.md) | policy surfaces, trust boundaries, and enforcement limits |
| [Operator Surface](./operator-surface.md) | observability, information hierarchy, and interaction design |

## Current Implementation Themes

The current `ddudu` implementation is especially shaped by a few practical choices:

- request execution, routing, workflow state, team orchestration, and background lifecycle now sit behind separate runtime boundaries instead of one controller blob
- pure external research takes a lightweight context path and can fan out into multiple read-only workers when the prompt names multiple subjects
- the operator surface now prioritizes run state, todo ownership, worker visibility, and explicit ask-user choices over redundant runtime detail

## What These Docs Are Not

These are not marketing notes and not command references.

They are intended to answer:

- why this subsystem exists
- what it should own
- what it should not own
- where it tends to fail
- what `ddudu` currently does

That makes this folder closer to a living architecture notebook than a polished product manual.
