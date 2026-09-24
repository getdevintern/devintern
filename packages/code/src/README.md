# @devintern/code - TypeScript Source

This directory contains the TypeScript source code for @devintern/code.

## Structure

```
src/
├── index.ts              # Main CLI entry point
├── worker.ts             # Worker daemon entry point
├── webhook-server.ts     # Direct webhook server entry point
├── dashboard-server.ts   # Local dashboard server entry point
├── lib/                  # Core library modules (context-first, provider-second)
│   ├── code-host/        # PR/MR providers: provider.ts, shared.ts, github/, gitlab/, bitbucket/
│   ├── trackers/         # Task trackers: client.ts, manager.ts, capabilities.ts, <provider>/
│   ├── acquirers/ review/ relay/ worker/ state/ observability/
│   ├── task/ agent/ config/ init/ automation/ workspace/
│   └── utils.ts lock-manager.ts   # cross-cutting low-level helpers
└── types/                # TypeScript type definitions
```

## Development

### Prerequisites

- Node.js 18+
- TypeScript (installed as dev dependency)

### Commands

```bash
# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Development mode (watch for changes)
npm run watch

# Run with ts-node (development)
npm run dev TASK-123

# Clean build directory
npm run clean
```

### Type Definitions

The project includes comprehensive TypeScript interfaces:

- **JiraIssue**: Complete JIRA issue structure
- **JiraComment**: Comment data with Atlassian Document Format
- **LinkedResource**: External links and references
- **FormattedTaskDetails**: Processed task data for Agent
- **AtlassianDocument**: Rich text document structure

### Adding New Features

1. Add types to `src/types/jira.ts` if needed
2. Implement functionality in appropriate `src/lib/` module
3. Update main CLI in `src/index.ts` if adding new options
4. Build and test: `npm run build && npm test`

### Code Style

- Use TypeScript strict mode
- Prefer interfaces over types for object definitions
- Use proper error handling with typed catch blocks
- Document public methods with JSDoc comments
- Follow existing naming conventions
