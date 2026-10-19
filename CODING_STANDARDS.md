# Coding standards

## Parse external data at the boundary

Data crossing into the process — tracker/API payloads, `JSON.parse` and HTTP
responses, config files, env vars, CLI arguments, IPC messages, database rows,
file contents — is `unknown`, not a domain type.

- Parse once, where the data crosses in, into a named domain type; trust it
  afterwards instead of re-validating deep in call chains.
- Use the repo's schema/validation library before hand-writing guards, and
  derive the TS type from the schema so they can't drift.
- Never let `any`/`unknown` flow past the boundary into core logic.
- Cast (`as`) only after validation; `satisfies` validates without widening.
- Prefer `unknown` over `any`; a genuine ad-hoc `any` needs a boundary reason.

## Lint enforcement

- `.oxlintrc.json` enables `typescript/no-explicit-any` and
  `typescript/ban-types`.
- Tests are exempt (fixtures build malformed inputs on purpose).
- A ratchet-baseline override lists files whose `any` predates the rule; type
  each boundary and delete its entry rather than growing the list.
