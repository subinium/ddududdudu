# Operator Surface

## Scope

This document covers the user-facing control surface of a coding harness.

In `ddudu`, that is primarily the native TUI, but the design principles apply to any operator interface.

## Philosophy

The UI is part of the control plane.

Once a harness can:

- queue work
- detach jobs
- delegate workers
- repair failures
- apply patches

the interface stops being ornamental.
It becomes part of the trust model.

## Core Goal

The operator surface should make the harness legible.

It does not need to mimic a full IDE.
It needs to answer the right questions quickly.

## Questions The UI Must Answer

At any time, the operator should be able to tell:

- what is running
- what is queued
- what is blocked
- what already completed
- which worker owns which task
- whether verification has passed
- whether the harness is waiting on policy or user input
- which option the harness is asking the user to choose from

If these are unclear, trust collapses even when the underlying system is technically correct.

## Common Failure Modes

### Transcript overload

Symptoms:

- tool logs flood the main transcript
- internal state messages displace the actual answer

### Hidden state

Symptoms:

- queue lives inside the composer
- workers run with no visible ownership
- background jobs exist but do not feel resumable

### Weak progress signals

Symptoms:

- only a spinner is visible
- task structure is implicit
- verification state is delayed or opaque

### Decorative density

Symptoms:

- too much chrome
- too many low-value status rows
- implementation details occupying first-class space

Effect:

- important state becomes harder to scan exactly when the system becomes more capable

## Information Hierarchy

High-signal state should appear first:

1. current run
2. todo board
3. run checklist
4. workers and ownership
5. detached jobs
6. queue
7. context and systems

Low-signal internals should be pushed into inspectors, palettes, or explicit secondary surfaces.

Examples:

- raw provider notes
- long tool histories
- full injected context dumps
- full diffs unless requested

This hierarchy is not cosmetic.
It is a prioritization of operator attention.

## Interaction Surfaces

Different UI regions should carry different classes of information:

- the main transcript should show user-visible answers and high-level progress
- the side rail should show run status, todos, worker ownership, detached jobs, queue, context, and systems
- the composer should surface ask-user choices directly instead of hiding them behind a generic prompt

When these roles blur together, operators lose confidence even if the model is technically still working.

## Progress Model

A useful operator surface distinguishes:

- active
- pending
- completed
- failed
- blocked on approval

That structure is significantly more trustworthy than generic activity indicators.

## ddudu Implementation Notes

`ddudu` currently leans on:

- a shared todo board separated from the run checklist
- worker-to-task mapping for delegated and tool-driven subagents
- heartbeat summaries when long-running work goes quiet
- detached job state
- queue visibility
- visible ask-user options in the composer
- context/system summaries instead of repeated provider trivia

The long-term quality bar is not "more panels".
It is "less ambiguity about system state".

## Design Rule

The operator surface should compress complexity without hiding ownership, progress, or risk.
