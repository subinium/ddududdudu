# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-03-11

### Added

- **Cost budget tracking**: Per-session cost tracking with configurable warning thresholds
  and hard-stop enforcement. New `cost_budget` config key with `maxPerSessionUsd` and
  `warningThreshold` options. Budget events fire callbacks at 80% and 100% usage.
- **Memory Promotion 2.0**: Scored promotion pipeline with five weighted dimensions
  (stability, reuse, specificity, verification, novelty). Jaccard-based dedupe,
  merge-on-similarity, and confidence metadata as YAML frontmatter on promoted entries.
- **Benchmark overhaul**: Parallel execution with configurable concurrency, resumable runs,
  failure mode categorization (timeout, crash, setup-failed, verification-failed, wrong-output),
  cost tracking, and multi-model side-by-side comparison.
- **CI pipeline**: GitHub Actions workflow with three parallel jobs — typecheck + lint,
  test, and Rust TUI build (ubuntu + macOS matrix).
- **Biome lint/format**: Replaced ad-hoc checks with Biome for fast, unified lint and
  format enforcement. New `lint:biome`, `format`, and `format:check` scripts.
- **Test coverage**: Added `c8` for coverage reporting via `test:coverage` script.
- **Makefile**: Standard build targets (build, dev, typecheck, lint, format, test, bench,
  clean, install, ci) for consistent local and CI workflows.
- **`.editorconfig`**: Standardized editor settings across contributors.

### Changed

- **In-memory execution scheduler**: Replaced filesystem-based slot leasing (mkdir as
  mutex, stat for stale checks, JSON write per lease, 125ms poll) with a pure in-memory
  semaphore queue. Eliminates all filesystem I/O from the scheduling hot path — the
  single biggest latency source on every API request and delegation.
- **System prompt caching**: Added hash-based invalidation cache to `refreshSystemPrompt()`.
  Skips the full rebuild (6+ file reads, memory loading, skill concatenation) when inputs
  have not changed, cutting 200–600ms per cache hit. Invalidates automatically on mode
  switch, memory write, MCP reload, and config change.
- **Budget enforcement wired**: Cost budget now enforced in the request execution path.
  Pre-request guard checks `isOverBudget()` and `shouldWarnBudget()` before every API
  call. Budget config loaded from `cost_budget.maxPerSessionUsd` at boot and reload.
- **Memory promotion wired**: Successful verification runs now trigger the scored
  promotion pipeline automatically — `scoreCandidate` → `decidePromotion` →
  `dedupeAgainstExisting` → `append()` with confidence metadata. Promotion failures
  are silently caught to never block the main flow.
- **LSP refresh parallelized**: All LSP server spec checks now run concurrently instead
  of sequentially. Added 60-second TTL cache for `commandExists` shell-outs to avoid
  redundant process spawns on repeated refreshes.
- **State serialization optimized**: Replaced expensive `JSON.stringify` comparison in
  `emitStateNow()` with a version counter, eliminating deep-copy overhead when no state
  mutations have occurred.
- **Controller decomposition**: Extracted slash command handlers from the 8K-line
  controller monolith into modular command files under `src/tui/native/commands/`.
- **TUI palette**: Switched to Dracula-pink color scheme with warm neutral muted tones.
  Original ddudu pink (`#F7A7BB`) as primary accent, dark background (`#121218`),
  no blue-purple tint in secondary colors.
- **Git sidebar**: New sidebar section showing current branch, staged/unstaged file
  counts, and changed file list (max 5 with overflow). Powered by async git state
  collection with 2-second TTL cache, refreshed on file-mutating tool calls.
- **Sidebar density**: Empty sections (idle workers, empty todo board) are now hidden
  instead of showing placeholder text. Section headers use subtle muted styling.

### Fixed

- **Stale build artifacts**: Removed empty `dist 2` through `dist 9` directories.
- **Dependency hygiene**: Moved `@types/js-yaml` to devDependencies. Moved LSP server
  packages (`bash-language-server`, `typescript-language-server`,
  `vscode-langservers-extracted`, `yaml-language-server`) to optionalDependencies.

## [0.4.2] — 2026-03-09

- Tighten execution flow and ask-user runtime.
- Refresh architecture and operator notes.

## [0.4.1] and earlier

See git history for prior changes.
