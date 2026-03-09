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
2. checklist or todo state
3. workers and ownership
4. detached jobs
5. queue
6. context and systems

Low-signal internals should be pushed into inspectors, palettes, or explicit secondary surfaces.

Examples:

- raw provider notes
- long tool histories
- full injected context dumps
- full diffs unless requested

This hierarchy is not cosmetic.
It is a prioritization of operator attention.

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

- checklist-driven workflow summaries
- worker-to-task mapping
- detached job state
- queue visibility
- context/system summary instead of verbose internals

The long-term quality bar is not "more panels".
It is "less ambiguity about system state".

## Design Rule

The operator surface should compress complexity without hiding ownership, progress, or risk.
