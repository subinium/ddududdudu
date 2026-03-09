# Design Principles

## Scope

This document captures the higher-level philosophy behind `ddudu`.

The rest of the docs explain individual subsystems.
This file explains the recurring worldview behind those subsystem decisions.

## 1. The Harness Is The Product

A model without a harness is mostly a text generator.

The harness is what gives the model:

- tools
- durable state
- continuity
- verification
- delegation
- operational boundaries

That means the useful unit of design is not only "the prompt".
It is the composition of prompt, tools, state, policy, and operator visibility.

## 2. Performance Is Mostly A Systems Problem

When people say an AI coding tool "performs better", that can mean many different things:

- it reaches a valid result faster
- it retries less
- it wastes fewer tokens
- it loses context less often
- it makes failures easier to recover from

Those gains often come from the harness, not only from the model.

## 3. Context Should Be Selected, Not Accumulated

The context engine should not optimize for maximum inclusion.
It should optimize for signal density.

That implies:

- relevant file ranges over full files
- typed artifacts over transcript replay
- purpose-aware memory selection over memory dumps
- changed-files-first retrieval when edits are active
- readable extraction over raw web noise

## 4. State Should Belong To The Harness

Provider runtimes are execution engines.
They should not be the only durable record of work.

`ddudu` therefore treats:

- canonical session state as harness-owned truth
- provider sessions as runtime-specific execution state

This lets the system preserve continuity even when providers, modes, or workers change.

## 5. Delegation Is A Compression Strategy

Delegation is not primarily about having more agents.
It is about using isolation and specialization to reduce context load.

Delegation is only useful if it:

- bounds the task
- defines an expected deliverable
- carries explicit success criteria
- returns something more structured than generic prose

## 6. Verification Is The Default Loop

The system should not treat verification as a nice-to-have after generation.

A serious harness should be built around loops such as:

1. execute
2. verify
3. repair
4. escalate
5. apply or report

This biases the system toward completed work rather than plausible work.

## 7. Trust Must Live In Runtime Policy

Natural-language safety guidance is not enough once the harness can:

- execute shell commands
- touch secrets
- make network calls
- invoke MCP tools
- modify the workspace

Trust therefore needs:

- explicit policy
- explicit risk classification
- observable approval boundaries
- runtime enforcement

## 8. The UI Is Part Of The Control Plane

Once a harness supports:

- detached jobs
- queued work
- delegated workers
- repair loops
- background execution

the interface stops being ornamental.

It becomes part of the trust model because it determines whether the operator can understand:

- what is running
- what is blocked
- what already passed
- who owns what

## 9. ddudu Is A Control Plane Around Provider Workers

`ddudu` is not built on the assumption that official tools are weak.

It is built on the assumption that there is still useful design space above provider runtimes for:

- custom orchestration
- stricter context discipline
- typed handoffs
- stronger verification loops
- different trust policy
- a different operator surface

## Design Rule

Treat the harness as an operating system for software work, not as an oversized chat prompt.
