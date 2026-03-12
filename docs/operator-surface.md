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
2. git status (branch, changed files, staged/unstaged)
3. todo board
4. run checklist
5. workers and ownership
6. detached jobs
7. queue
8. context and systems

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
- global actions such as command search, session picking, and queue inspection should be discoverable from shortcuts and an explicit palette, not only from memorized slash commands

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

## Visual Encoding

Visual encoding is the practice of using spatial position, color, weight, and rhythm to carry operational meaning without labels.

A well-encoded interface answers the operator's questions before they are asked.

### Zone Differentiation

The TUI divides the screen into three visual zones with distinct backgrounds:

| Zone | Role | Visual treatment |
| --- | --- | --- |
| Sidebar | system state, context, jobs | recessed (darker background) |
| Main transcript | conversation, answers, progress | neutral (default background) |
| Composer | user input, ask-user prompts | elevated (slightly lighter background) |

This spatial encoding lets the operator orient without reading labels. Where the eye lands conveys what kind of information it is.

### Message Differentiation

| Source | Visual treatment | Why |
| --- | --- | --- |
| User | pure white text | the operator's own words should be instantly recognizable |
| Assistant | warm neutral text | distinct from user, readable, not competing for attention |
| System / tool output | muted text | infrastructure should recede, not dominate |

### Perceived Speed

A system that looks alive earns more trust than one that looks frozen.

ddudu uses deliberate perceived-speed signals:

- blinking cursor during generation
- breathing animation for model thinking
- live token counter
- streaming text deltas (~80 bytes per event)
- spinner icons on in-progress tool calls

These are not cosmetic. They are feedback signals that tell the operator the system is working even before the first answer token arrives.

### Result Augmentation

The harness injects behavioral nudges into the model's context after certain tool calls:

- verification reminders after file edits
- diagnostic suggestions after failed tool calls
- tool usage hints when the model appears to be working manually

These nudges are rule-based, cooldown-gated, and scoped to execution context. They help the model self-correct without waiting for the operator to intervene.

### Prompt History

The composer supports Arrow-Up/Down prompt history recall:

- Arrow-Up when the composer is empty recalls the previous submitted prompt
- Arrow-Down navigates forward through history
- The current draft is stashed and restored when exiting history mode
- Duplicate consecutive prompts are not stored

This makes repeated workflows fast and reduces the friction of re-issuing similar prompts.

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
- muted inline tool call rendering in the transcript (✓/✗/spinner status icons in dim style so tool activity recedes behind answers)
- color-coded context meter in the footer bar (normal → orange at 60% → red at 80%)
- delta streaming pipeline for immediate visual feedback (~80-byte events, blinking cursor, live token counter)
- thinking breathing animation with dimmed reasoning text
- zone-differentiated backgrounds: recessed sidebar, neutral main, elevated composer
- message-level visual encoding: pure white for user, warm neutral for assistant, muted for system
- result augmentation engine: rule-based behavioral nudges injected after tool calls, with cooldown
- Arrow-Up/Down prompt history recall with deduplication and draft stash
- command palette and session picker shortcuts so common control actions stay discoverable while idle
- file-path insertion should be as cheap as command search, with a fast picker instead of manual path typing
- API resilience: automatic retry with exponential backoff and jitter for transient provider errors

Empty sidebar sections (idle workers, empty todo board) are hidden to reduce decorative density.
Git status (branch, changed files, staged/unstaged counts) now appears as a first-class sidebar section.
The sidebar context rail shows footprint percentage, a visual meter bar, and token counts.
Table rendering uses a minimum column width of 8 characters to prevent aggressive truncation of narrow columns.

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
