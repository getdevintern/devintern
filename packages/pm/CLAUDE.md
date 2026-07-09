# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a CLI utility built with Bun and TypeScript. Bun is used as the JavaScript runtime, package manager, bundler, and test runner.

## Runtime & Tooling

**Always use Bun instead of Node.js, npm, pnpm, or other tools:**

- Runtime: `bun <file>` (not `node` or `ts-node`)
- Package management: `bun install` (not `npm install` or `yarn install`)
- Scripts: `bun run <script>` (not `npm run`)
- Testing: `bun test` (not `jest` or `vitest`)
- Bundling: `bun build <file>` (not `webpack` or `vite`)

## Development Commands

- **Install dependencies**: `bun install`
- **Run the application**: `bun run index.ts`
- **Run with hot reload**: `bun --hot index.ts`
- **Type checking**: Use TypeScript compiler with strict mode enabled

## Bun-Specific APIs for CLI Development

When writing code for this CLI utility, prefer Bun's built-in APIs over npm packages:

- **File I/O**: `Bun.file()` and `Bun.write()` instead of `node:fs` readFile/writeFile
- **Shell commands**: `Bun.$\`command\`` instead of `execa` or `child_process`
- **Environment variables**: Automatically loaded from `.env` (no need for `dotenv`)
- **Command-line arguments**: `Bun.argv` or `process.argv`
- **Process management**: `process.exit()`, `process.stdout`, `process.stderr`, `process.stdin`
- **Path operations**: Use `node:path` for cross-platform path handling
- **SQLite** (if needed): `bun:sqlite` instead of `better-sqlite3`

## TypeScript Configuration

The project uses strict TypeScript settings:
- Target: ESNext
- Module: Preserve (bundler mode)
- JSX: react-jsx
- Strict mode enabled with additional checks:
  - `noFallthroughCasesInSwitch`
  - `noUncheckedIndexedAccess`
  - `noImplicitOverride`

## CLI Development Patterns

### Reading User Input
```ts
// Read from stdin
const input = await Bun.stdin.text()

// Or line by line
for await (const line of Bun.stdin.stream()) {
  console.log(line)
}
```

### File Operations
```ts
// Reading files
const file = Bun.file("path/to/file.txt")
const contents = await file.text()

// Writing files
await Bun.write("output.txt", "content")

// Check if file exists
const exists = await file.exists()
```

### Shell Commands
```ts
// Execute shell commands with Bun's shell
const result = await Bun.$`ls -la`
console.log(result.stdout.toString())
```

### Command-line Arguments
```ts
// Access arguments
const args = Bun.argv.slice(2) // Skip 'bun' and script name
```

### Exit Codes
Use appropriate exit codes for success (0) and errors (non-zero).

## Additional Resources

For detailed Bun API documentation, refer to `node_modules/bun-types/docs/**/*.md`.
