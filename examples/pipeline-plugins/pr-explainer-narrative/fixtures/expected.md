## Why this change is needed

The `greet` helper ignored the caller's name and always returned a bare
"Hello", so callers could not produce a personalized greeting. The task is to
make the greeting include the name.

## What changed

- `greet(name)` now interpolates the provided name into the returned string and
  appends the trailing punctuation the task asked for.

## Validation actually performed

- `verify` recorded `continue`, meaning the committed diff met the task
  requirements.
- No dedicated unit test was captured in the evidence.

Observed evidence: the `verify` step result. Inference: the change is a
one-line, pure-function edit with no external side effects.

## Material risks

- Low. The function remains pure and its return type is unchanged.

## Where reviewers should focus

- `src/greet.ts`: confirm the expected wording and punctuation.
