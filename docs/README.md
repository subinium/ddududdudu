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
4. the smallest executable unit should start first
5. verification should sit at the boundaries where work can break, land, or ship
6. trust should be enforced by runtime policy, not just requested in language
7. execution should be only as heavy as the task requires
8. parallelism should be controlled by policy, not by creating more agent ceremony
9. the UI is part of the control plane, not a cosmetic shell
10. interactive questions should be modeled state, not ad hoc terminal text

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
- lightweight research fan-out now has its own runtime boundary instead of pretending every parallel request is a managed team run
- pure external research takes a lightweight context path and can fan out into multiple read-only workers when the prompt names multiple subjects
- mixed implementation work now prefers direct or delegated execution before escalating into a managed team run
- provider, search, write, and verification pressure now share one scheduler model instead of being treated as unrelated waits
- parallel team execution now continues as dependencies clear instead of waiting on full round barriers
- ask-user prompts are now structured runtime state with question kind, defaults, validation, and answer provenance instead of a plain string prompt
- sessions and operator settings are global-first by default, with project `.ddudu/` config as an explicit override layer
- project instructions support `AGENTS.md` as the cross-tool standard alongside `.ddudu/DDUDU.md`, so rules authored once apply across Claude Code, opencode, Codex CLI, and Amp
- the operator surface now prioritizes run state, todo ownership, worker visibility, and explicit ask-user choices over redundant runtime detail
- the TUI uses zone-differentiated visual encoding — recessed sidebar, neutral main, elevated composer — so the operator can orient spatially before reading any text
- result augmentation injects behavioral nudges after tool calls (verification reminders, diagnostic hints) so the model self-corrects without operator intervention
- API calls now have automatic retry with exponential backoff and jitter for transient provider errors, with error classification that separates retryable failures from auth and fatal errors
- the composer supports prompt history recall (Arrow-Up/Down) with deduplication and draft stash, making repeated workflows fast
- boot initialization is parallelized into two `Promise.all` phases (config/providers/toolbox/hooks, then systemPrompt/epistemicState/backgroundJobs/MCP) with per-operation error resilience so a single failure cannot block the boot
- post-response verification now runs as a non-blocking background operation so the composer is released immediately after streaming completes, instead of blocking on lint/test/build before the operator can type
- vague research prompts are intercepted by a specificity heuristic and routed through a structured clarification interview before fan-out, reducing wasted parallel workers on under-specified queries
- file tool operations enforce a working-directory boundary to prevent path traversal outside the project root
- delegation runtime exposes a configurable `defaultMaxTokens` so token budget is no longer hardcoded per delegation call

## What These Docs Are Not

These are not marketing notes and not command references.

They are intended to answer:

- why this subsystem exists
- what it should own
- what it should not own
- where it tends to fail
- what `ddudu` currently does

That makes this folder closer to a living architecture notebook than a polished product manual.
