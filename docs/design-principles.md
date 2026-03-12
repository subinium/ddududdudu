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

In practice that often means:

- route obvious research work before paying for a full repo snapshot
- split itemized comparison requests into actual parallel workers instead of one overloaded researcher
- avoid write-oriented isolation and verification costs for read-only research by default

Performance is therefore not "how many subagents exist".
It is "how much unnecessary execution weight the harness avoids".

That changes the optimization target:

- reduce bootstrap cost per unit of work
- let ready work continue without waiting for unrelated slow work
- separate search, model, write, and verification bottlenecks instead of treating them as one queue

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

That also means the decomposition itself matters.
If the user asks for `A/B/C` research, the useful split is usually by subject, not by abstract role label alone.

## 6. Prefer The Smallest Executable Unit

The harness should prefer the smallest unit of work that can be started immediately.

That means:

- direct execution before managed orchestration when one worker can start now
- delegation before full team runs when one coherent owner can carry the next step
- subject shards for independent comparison work
- narrow diffs and incremental notes over waiting for one grand final answer

The point is not just lower cost.
It is faster accumulation of real progress.

## 7. Execution Should Be Only As Heavy As Necessary

Once the smallest useful unit is identified, the harness should still avoid paying the same cost for every task.

`ddudu` should prefer policy-driven execution weight:

- minimal context before full context
- shared workspace before isolated workspace when safe
- no verification before light verification when that is sufficient
- lightweight fan-out before managed multi-agent orchestration when the work is mostly read-only

This is why "fast" and "safe" are not opposites here.
The goal is to apply the smallest runtime that can still be trusted.

## 8. Parallelism Should Increase Throughput, Not Ceremony

Parallelism is useful when the work is actually independent.

That implies:

- subject fan-out for independent comparison work
- many readers or scouts, but bounded writers
- continuous scheduling when dependencies clear
- partial results as soon as shards complete
- final synthesis or verification only where it adds real value

The system should not create a fully managed subagent for every tiny shard by default.
That often increases coordination cost more than throughput.

## 9. Verification Should Sit At Boundaries

The system should not treat verification as a nice-to-have after generation.
But it also should not pay the same verification cost for every shard.

A serious harness should be built around loops such as:

1. execute
2. verify
3. repair
4. escalate
5. apply or report

The important nuance is where the loop sits.

- write-capable workers often need verification before apply
- review and ship boundaries often need stronger checks than read-only shards
- pure research or narrow scouts often only need evidence quality, not full repo verification

This biases the system toward completed work rather than plausible work without forcing every worker through the heaviest path.

## 10. Trust Must Live In Runtime Policy

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

## 11. Personas Are Interfaces, Not Architecture

Modes, specialist labels, and agent names are useful operator affordances.
They are not the real execution model.

The real model should live in policy such as:

- how much context to load
- whether the task is shardable
- how many readers and writers to allow
- what verification tier to require
- what isolation boundary to enforce

If the architecture depends too much on persona labels, performance tuning and correctness both get harder.

## 12. User Questions Should Be Structured State

Once the harness can ask the operator to resolve ambiguity, choose a risk boundary, or confirm a dangerous action, those questions stop being casual text.

They become execution state.

That means a serious harness should model:

- question kind such as input, confirm, select, number, or path
- choice metadata such as recommended or dangerous options
- defaults and validation
- answer provenance such as selected choice vs custom typed input

If user questions are only raw strings, the UI becomes inconsistent and policy prompts become harder to trust.

## 13. The UI Is Part Of The Control Plane

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

## 14. Perceived Speed Is Real Speed

A system that looks frozen feels broken even if it is working correctly.

Perceived speed comes from:

- immediate visual feedback: streaming deltas, blinking cursors, breathing animations
- live progress signals: token counters, spinner icons on tool calls, typing indicators
- spatial orientation: zone-differentiated backgrounds that let the eye track state without scanning

These are not cosmetic polish. They are trust signals. An operator who cannot see the system working will interrupt it, start over, or stop trusting the output.

## 15. Visual Encoding Should Carry Meaning

Color, position, and weight should encode operational semantics, not just aesthetics.

That means:

- different UI zones should have distinct backgrounds so the operator can orient spatially
- message sources (user, assistant, system) should be visually distinguishable without reading prefixes
- tool activity should recede into muted rendering so answers are not buried in plumbing
- tables and structured output should have minimum readable widths to avoid information loss through aggressive truncation

If visual encoding is arbitrary, the operator has to read everything. If it is semantic, they can scan.

## 16. The System Should Nudge The Model

A harness can improve model behavior not only through the initial prompt but through runtime augmentation.

Result augmentation injects context-aware behavioral nudges after tool calls:

- verification reminders after file edits
- diagnostic suggestions after failed tool calls
- tool usage hints when the model appears to be working manually

These nudges are:

- rule-based, not LLM-generated (zero latency cost)
- cooldown-gated to avoid nagging
- scoped to execution context so they stay relevant

This is a form of context engineering applied at the output boundary rather than the input boundary.

## 17. ddudu Is A Control Plane Around Provider Workers

`ddudu` is not built on the assumption that official tools are weak.

It is built on the assumption that there is still useful design space above provider runtimes for:

- custom orchestration
- stricter context discipline
- typed handoffs
- stronger verification loops
- different trust policy
- a different operator surface

## Design Rule

Treat the harness as an operating system for software work:
start the smallest executable unit quickly, accumulate visible progress, ask explicit structured questions when operator input is needed, and only add heavier orchestration when it increases throughput or trust.
