# @devintern/agent-harness

Source-only package that abstracts AI coding agent CLIs (Claude Code, Opencode,
Codex, Cursor CLI, Antigravity/agy, Grok Build, Kimi, ...) behind one
[`AgentHarness`](src/types.ts) interface, plus the diagnostics runners need to
interpret headless runs: mode enforcement, max-turns detection,
usage/rate-limit detection, incomplete-implementation and open-question
detection.

This README is the onboarding checklist for **adding a new harness**. It links
to source rather than duplicating the inline docs in [`src/types.ts`](src/types.ts) — read those JSDoc blocks; they are authoritative.

## Adding a new harness

All steps are required; missing any one produces a harness that compiles but is
silently unusable (not resolvable by id, not exported, or misbehaving under
constrained modes).

1. **Create `src/harnesses/<name>.ts`** implementing the
   [`AgentHarness`](src/types.ts) interface. Start from an example:
   - Minimal case (arg-only flags, no constrained modes):
     [`src/harnesses/kimi.ts`](src/harnesses/kimi.ts)
   - Full-featured (plan/readonly modes, allowlisted external tools, turn
     limits): [`src/harnesses/claude-code.ts`](src/harnesses/claude-code.ts)
   - Native image input (`imageInput: "native"` + `buildImageArgs`):
     [`src/harnesses/codex.ts`](src/harnesses/codex.ts)

2. **Export it from [`src/harnesses/index.ts`](src/harnesses/index.ts)**.

3. **Re-export it from [`src/index.ts`](src/index.ts)** (the package entry point).

4. **Register it in [`src/registry.ts`](src/registry.ts)** with
   `registerHarness(new YourHarness())`. Registration is keyed by
   `harness.name`; without it `getHarness("your-id")` returns `undefined`.

5. **Add an alias in [`HARNESS_ALIASES`](src/registry.ts)** if users may type a
   different id than the canonical name (a bare binary name such as `agy`).
   Aliases map alternate ids → canonical registered names and are *not* listed
   separately by `listHarnesses()`.

### Update the tests

- [`tests/registry.test.ts`](tests/registry.test.ts) asserts an exact built-in
  count (`expect(harnesses.length).toBe(N)`) plus each registered name — bump
  the count and add your id, or the suite fails.
- [`tests/harnesses.test.ts`](tests/harnesses.test.ts) has a `describe` block
  per harness asserting metadata (`name`, `displayName`, `defaultPath`,
  `promptFlag`, `supportsMaxTurns`) and exact `buildArgs()` output for empty /
  partial / full option sets, including mode combinations. Mirror that layout.
- If you extend shared behavior (prompt delivery, attachments, limit
  patterns), the relevant suites live alongside:
  [`tests/prompt-args.test.ts`](tests/prompt-args.test.ts),
  [`tests/attachments.test.ts`](tests/attachments.test.ts),
  [`tests/detect-usage-limit.test.ts`](tests/detect-usage-limit.test.ts), etc.

## Capability flags that matter

See [`AgentHarness`](src/types.ts) for full semantics. Quick decision table:

| Flag | When it matters |
| --- | --- |
| `name` / `displayName` / `defaultPath` | Always. `defaultPath` is the binary looked up on `PATH` (override-able via resolver env vars). |
| [`supportedModes`](src/modes.ts) | List only plan/readonly modes the CLI can **natively enforce** via flags. If you cannot enforce them, leave empty (or omit) — requests fail closed via `assertModeSupported` inside `buildArgs`. Never fake a mode by ignoring it. |
| `supportsMaxTurns` | Set `true` only if the CLI accepts a turn-limit flag *and* emits a recognizable diagnostic on exhaustion. Callers skip transcript scanning when this is false/unset, so tool output cannot be mistaken for a turn-limit error. |
| `constrainedModeAllowsExternalTools` | Set `true` only if your constrained mode still permits network + MCP tools. No built-in harness sets it today (Codex's read-only sandbox disables network; Claude's plan mode denies non-annotated MCP tools, which aborts headless runs). Callers whose agents need web/MCP access skip constrained modes unless this is true. |
| `promptFlag` | Set when the prompt must arrive as a flag value (`kimi --prompt "..."`). Omit for positional prompts (`codex exec "..."`). Prefer argv over stdin — see below. |
| `imageInput` / `buildImageArgs` | `"path"` (default): images go into the prompt as markdown paths only. `"native"`: also emit CLI flags via `buildImageArgs(paths)` after the prompt (Codex `-i`). Runners call [`preparePromptWithAttachments`](src/attachments.ts); paths should also appear in `attachmentPaths`. |

Inside `buildArgs`: always call `assertModeSupported(this, options.mode)`
first; use [`effectiveSkipPermissions`](src/modes.ts) instead of reading
`options.skipPermissions` directly — constrained modes always suppress YOLO /
bypass flags. When `mode` is plan/readonly, never emit write-capable flags.

## Prompt & input conventions

- **Arg, not stdin.** The prompt goes on the command line via
  [`buildPromptArgs`](src/prompt-args.ts). Several TUI-first CLIs (Grok Build,
  Kimi, Goose, Qwen, agy) launch their interactive UI when no prompt argument
  is present and die headless with ENXIO / hang waiting for a terminal.
- **`cwd` vs `workingDir`.** Most CLIs inherit the working directory from the
  spawn's `cwd`. Some ignore it (opencode defaults to `$HOME`) and must consume
  `options.workingDir` explicitly as their own flag — see the `workingDir`
  note in [`src/types.ts`](src/types.ts) and how
  [`opencode.ts`](src/harnesses/opencode.ts) emits `--dir` (Grok: `--cwd`).
  Honor `workingDir` if your CLI needs it; otherwise ignore it.
- **Attachments.** Non-image files and default image handling are injected
  into the prompt text as an "Attached files" section by
  [`src/attachments.ts`](src/attachments.ts); native multimodal handling is
  opt-in via `imageInput`/`buildImageArgs`.

## Usage-limit detection (required review)

[`src/detect-usage-limit.ts`](src/detect-usage-limit.ts) classifies agent
output so callers don't retry pointlessly on rate limits — a usage limit must
NOT be retried until the reset window passes (see the module header for the
Claude Code messages like
`You've hit your session limit · resets 7:20pm (...)` and the opencode/Vercel
AI SDK examples like `AI_RetryError: ... Too Many Requests`). It also extracts
reset hints ("resets in 2h 15m") via `resetHintToMs`.

When adding a harness:

- Check whether its exhaustion output already matches the generic provider
  patterns (`rate_limit_error`, `Too Many Requests`, `quota exceeded`,
  HTTP 429 — accepted only on lines that look like real diagnostics, never raw
  transcript/source lines).
- If your CLI prints distinct whole-line subscription/spend/quota messages,
  **extend `USAGE_LIMIT_PATTERNS`** with them. Known gaps live in the module
  header comments: monthly-spend / credit-exhaustion limits often carry no
  timer-based reset hint; opencode may hide the provider error behind
  `--print-logs` structured lines, so scan output while streaming and kill the
  child as soon as the detector fires.
- Keep new patterns anchored to complete diagnostic lines. Substring matching
  sees tool transcripts (Codex writes its entire transcript to stderr) and this
  repository's own source — both have caused false positives before.
- Add cases to [`tests/detect-usage-limit.test.ts`](tests/detect-usage-limit.test.ts).

## Related diagnostics to review

- [`src/detect-max-turns.ts`](src/detect-max-turns.ts) — matches
  "Reached max turns (N)" style lines. Skipped entirely unless
  `supportsMaxTurns` is true. Confirm what your CLI prints when the turn cap
  hits and whether a pattern is needed.
- [`src/detect-incomplete-implementation.ts`](src/detect-incomplete-implementation.ts)
  — catches exit-0 runs whose stdout admits failure or is suspiciously short.
  Stderr is deliberately ignored here (Cursor emits transient recovered
  errors); know which channel your CLI uses for fatal-vs-transient messages.
- [`src/detect-open-questions.ts`](src/detect-open-questions.ts) — detects
  runs that ended asking the user a question instead of implementing (tail-of-
  output heuristics). Nothing to configure per harness, but verify your CLI's
  final-output shape doesn't false-positive.

## Edge cases

- **Deprecating / renaming a harness id.** Don't delete the old id outright;
  keep it resolving through `HARNESS_ALIASES` with `deprecated: true` and a
  migration `warning`. `getHarness` resolves aliases silently;
  [`resolveHarness`](src/resolver.ts) (the env-var-driven path, e.g.
  `AGENT_HARNESS=gemini`) prints the warning during the soft-deprecation
  window. Precedent: `gemini` → `antigravity` after Google retired Gemini CLI
  ([`src/registry.ts`](src/registry.ts), [`src/harnesses/gemini.ts`](src/harnesses/gemini.ts)).
- **CLIs that ignore `cwd`.** Covered above under `workingDir`.
- **Sandboxing.** Runs can be wrapped in OS-level isolation via
  [`src/sandbox/`](src/sandbox/) providers and
  [`spawnAgent`](src/spawn-agent.ts). If your CLI has its own sandbox (Codex's
  `--sandbox workspace-write`), note that nested Seatbelt is unsupported on
  macOS — see `applyNestingGuard` for how codex is special-cased under wrapper
  providers. Also list any paths/config dirs your CLI writes outside the repo
  (auth state, caches) since sandbox write-paths are constrained.

## Verify

From this package directory (`packages/agent-harness`):

```bash
bun run test        # bun test --timeout=30000
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint .
```

Before opening a PR, the monorepo pre-commit (lefthook) will additionally run
root-level `format` (oxfmt), `lint`, and `typecheck` sequentially — see the
root [AGENTS.md](../../AGENTS.md).
