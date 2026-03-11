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
- what resource is the bottleneck when work is waiting
- what already completed
- which worker owns which task
- whether verification has passed
- whether the harness is waiting on policy or user input
- which kind of answer the harness is asking for
- which option is selected or recommended by default
- whether custom input is allowed and why an answer was rejected

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
- repeated persona or model trivia
- full diffs unless requested

This hierarchy is not cosmetic.
It is a prioritization of operator attention.

## Interaction Surfaces

Different UI regions should carry different classes of information:

- the main transcript should show user-visible answers and high-level progress
- the side rail should show run status, todos, worker ownership, detached jobs, queue, context, and systems
- the composer should surface typed ask-user questions directly instead of hiding them behind a generic prompt

When these roles blur together, operators lose confidence even if the model is technically still working.

## Ask-User Surface

Interactive questions are part of the control plane too.

A useful ask-user surface should make these visible without forcing the operator to infer them:

- question kind such as confirm, single-select, input, number, or path
- whether the answer is required
- default answer or default choice
- recommended or dangerous options
- validation expectations
- whether the submitted answer came from a picked choice or free-form text

This matters most for:

- permission prompts
- destructive confirmations
- session and resume pickers
- clarifying implementation tradeoffs during a run

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
- typed ask-user prompts in the composer with validation hints and explicit choice metadata
- numeric shortcuts and default-choice handling for strict confirmations
- context/system summaries instead of repeated provider trivia
- running and waiting detail that can reflect scheduler pressure such as search or verification contention

The long-term quality bar is not "more panels".
It is "less ambiguity about ownership, waiting reason, and completion state".

## Control Bias

The side rail should bias toward execution truth, not model identity.

That means:

- task ownership is more important than which persona label produced it
- verification state is more important than eloquent intermediate prose
- wait reasons are more important than a generic spinner
- one shared context summary is more useful than repeating the same runtime identity in multiple places

## Design Rule

The operator surface should compress complexity without hiding ownership, progress, or risk.
