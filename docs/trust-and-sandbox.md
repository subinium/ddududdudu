# Trust And Sandbox

## Scope

This document covers execution trust, policy, and enforcement boundaries in a coding harness.

## Philosophy

Any harness that can modify a repository, execute shell commands, access networks, or call external tools needs a stronger trust model than natural-language caution.

The core philosophy is:

- risk should be visible
- trust should be configurable
- policy should be enforced before execution
- documentation should not imply guarantees the runtime does not actually provide

## Policy Layer vs Enforcement Layer

These are different things.

| Layer | Purpose |
| --- | --- |
| Trust policy layer | classify risk, allow, ask, or deny |
| Sandbox enforcement layer | technically constrain filesystem, process, or network access |

Many systems implement the first and loosely describe it as the second.
Those should be kept distinct.

## Risk Surfaces

The main risk surfaces in a coding harness are usually:

- shell execution
- network access
- secret and credential access
- MCP servers and external tools
- delegated workers
- patch application into the main workspace

These surfaces differ in both blast radius and reversibility.

## Good Trust Design

### 1. Risk visibility

The harness should know whether an action is:

- local
- networked
- secret-adjacent
- destructive
- delegated
- external

### 2. Configurable trust

Useful control points include:

- global permission profile
- per-tool policy
- per-host network policy
- protected paths
- protected environment variables
- per-MCP-server trust tier

### 3. Runtime enforcement

Trust should not depend on the model remembering a paragraph.

The runtime should enforce:

- hard-blocked shell patterns
- explicit approval boundaries
- host-level trust
- secret boundaries

### 4. Layered policy

The useful question is not only "is this allowed?".
It is also:

- why is this allowed?
- under which profile?
- because of which tool policy?
- because of which host rule?
- because of which MCP trust setting?

### 5. Structured approvals

Approval prompts are part of enforcement, not cosmetic UX.

A good harness should surface:

- the action summary
- the current permission profile
- the relevant trust-boundary reason
- the default-deny path
- which choices are recommended or dangerous

This is especially important when the operator is switching into a more permissive mode or allowing a risky tool call.

## MCP Trust

MCP should be treated as a first-class trust surface.

Recommended tiers:

- `trusted`
- `ask`
- `deny`

Without this, MCP tends to become either unsafe or unusable.

## Worktrees vs Sandboxes

Git worktrees help with:

- patch isolation
- collision reduction
- safer delegated execution

Git worktrees do not solve:

- secret isolation
- host process isolation
- network isolation

They are operational isolation, not a complete sandbox.

## ddudu Implementation Notes

Current `ddudu` supports:

- hard-blocked shell patterns
- risk classification
- permission profiles
- per-tool policies
- host-based network trust
- protected secret paths and env vars
- MCP trust tiers
- structured approval prompts for risky tool calls
- explicit confirmation before switching into `permissionless`

What it does not yet provide is a full process-level sandbox such as container or VM isolation.

That limitation is intentional to document clearly.

## Design Rule

If the harness is powerful enough to act on the operator's behalf, trust policy must be a first-class subsystem with explicit boundaries and observable decisions.
