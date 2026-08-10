# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a CLI utility built with TypeScript. It is **portable** and runs under both Bun and Node.js/Electron. Bun remains the development toolchain (package manager, task runner, test runner, and bundler), but the application code uses only Node.js built-ins so it can be packaged for end users without requiring the Bun runtime.

## Runtime & Tooling

**Bun is used for development only:**

- Package management: `bun install` (not npm install or yarn install)
- Scripts: `bun run <script>` (not npm run)
- Testing: `bun test` (not jest or vitest)
- Bundling: `bun build <file>` (not webpack or vite)
- Local execution: `bun run index.ts`

**The application code itself runs under plain Node.js or Electron:**

- File I/O: `node:fs/promises` (readFile, writeFile, access, mkdir) via `lib/runtime/fs.ts`
- Shell commands: Avoid `Bun.$`; use `node:fs/promises` mkdir or `child_process` if necessary
- Environment variables: `process.env` (no dotenv dependency)
- Command-line arguments: `process.argv` via `lib/runtime/args.ts`
- Path operations: `node:path` and `node:url` via `lib/runtime/path.ts`
- Stdin prompts: `node:readline` via `lib/runtime/stdin.ts`
- Process management: `process.exit()`, `process.stdout`, `process.stderr`, `process.stdin`

## CLI Development Patterns

### File Operations

Always use the centralized runtime helpers rather than `Bun.file()` or `Bun.write()`:

```ts
import { readFile, writeFile, pathExists, mkdir } from "./runtime/fs.js";

const content = await readFile("path/to/file.txt");
await writeFile("output.txt", content);
const exists = await pathExists("path/to/check");
await mkdir("new/dir");
```

### Path Resolution

Replace `import.meta.dir` with the portable `getModuleDir(import.meta.url)`:

```ts
import { getModuleDir } from "./runtime/path.js";

const __dirname = getModuleDir(import.meta.url);
```

### Command-line Arguments

Use the args helper instead of `Bun.argv`:

```ts
import { getArgs } from "./runtime/args.js";

const args = getArgs(); // equivalent to process.argv.slice(2)
```

### Reading User Input

Use the cross-platform stdin helper (works in Node, Bun, and Electron):

```ts
import { askConfirm } from "./runtime/stdin.js";

const confirmed = await askConfirm("Continue?");
```

### Exit Codes

Use appropriate exit codes for success (0) and errors (non-zero).

## Agent harness switching

- CLI: `--harness <name>` overrides `AGENT_HARNESS` for one run (validated once in `main()` via `validateHarnessName`).
- Interactive: `Ctrl+G` opens a modal picker of **installed** harnesses (`listInstalledHarnesses`); ESC returns to the prior step.
- Desktop (`pm-desktop`): the header harness pill switches among installed harnesses and persists `AGENT_HARNESS` in `.devintern-pm/.env` (same resolution as CLI). Clears sticky `AGENT_CLI_PATH` on switch so a prior agent path cannot attach to the new harness.
- Do not expose `--agent-path`; CLI path resolution stays on PATH / `AGENT_CLI_PATH` / `<HARNESS>_CLI_PATH`.
- When `harnessName` is explicit, `resolveHarness` skips `AGENT_CLI_PATH` so a previous agent path does not stick.

## Build Output

The `bun run build` command targets **Node.js** (`--target=node`) so the resulting `dist/index.js` runs under plain Node.js without Bun installed. External dependencies (`ink`, `react`, `ink-scroll-view`) are left as externals and resolved at runtime.
