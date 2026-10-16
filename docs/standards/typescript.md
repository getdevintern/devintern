# TypeScript standard

Short, enforceable rules for `.ts`/`.tsx` in this repo. Adapted from the
[`typescript-best-practices`](https://github.com/cursor/plugins/blob/main/pstack/skills/typescript-best-practices/SKILL.md)
skill and its `type-system-discipline` / `boundary-discipline` principles.

## Parse external data at the boundary

External data is **untyped until you parse it**. Data crossing into the process
— tracker/API payloads, `JSON.parse` and HTTP responses, config files,
environment variables, CLI arguments, IPC messages, database rows, file
contents — is `unknown`, not a domain type.

- Parse once, where the data crosses in, into a **named domain type**. After the
  parse, trust that type; do not re-validate deep in call chains.
- Reach for the repository's existing schema/validation library before
  hand-writing a property-by-property guard, and derive the TS type from the
  schema so the two cannot drift.
- Do not let `any`/`unknown` flow past the boundary into core logic.
- Cast (`as`) only **after** the value has been validated. An `as` is a runtime
  crash waiting to happen; `satisfies` validates without widening.

```ts
// Don't: raw `any` crosses the boundary and is trusted indefinitely.
function loadConfig(raw: any): Config {
  return raw as Config;
}

// Do: parse at the boundary into a named type; the rest of the code trusts it.
function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) throw new Error("config must be an object");
  // validate fields (or `schema.parse(raw)`) before constructing Config
  return { /* ... */ };
}
```

Prefer `unknown` over `any`; a genuine ad-hoc `any` needs a boundary reason.

## Lint enforcement

`.oxlintrc.json` enables `typescript/no-explicit-any` and
`typescript/ban-types`. Tests are exempt (fixtures build malformed inputs on
purpose). A ratchet-baseline override lists files whose `any` predates the rule;
type each boundary and delete its entry rather than growing the list.
