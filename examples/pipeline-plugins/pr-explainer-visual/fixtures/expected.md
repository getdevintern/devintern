## Summary

`greet` now includes the caller's name and the trailing punctuation the task
required. The previous implementation returned a bare "Hello" and ignored the
name argument.

## Evidence

```text
src/greet.ts
└── greet(name)
    before: `return "Hello"`
    after:  `return \`Hello, ${name}!\``
```

- `verify` recorded `continue`, meaning the committed diff met the task
  requirements.
- Before/after execution results were not captured in the evidence.

## Merge Danger

- Blast radius: one pure function, `greet`, with no callers changed in this
  diff. Reverting restores the old bare greeting.
- Safe to ship without a staged rollout; the main risk is a wording mismatch
  with the task's expected punctuation.
