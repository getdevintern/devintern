# report-execution

Submit a redacted **DevIntern bug report** when a pipeline run records
warnings, or on every completed run when configured. The step attaches the
step history, recorded warnings, and optionally an evidence file through the
public `@getdevintern/code/report` API.

- API: `@getdevintern/code/report`
- DevIntern: the release that adds `devintern report`
- Mutates files: no
- Placement: after the checks you want to observe, before `finalize`
- Network: only when `dryRun` is `false`; the example ships with `dryRun: true`

## Important limitation

A pipeline `halt` stops later steps, so this step cannot observe a halt from an
earlier step. DevIntern's built-in automatic reporting handles exceptions and
halts; this recipe adds custom evidence for runs that complete with warnings.
Do not use it as a replacement for the CLI failure path.

## Files

| File                             | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `plugin.ts`                      | The step definition.                                       |
| `settings.json`                  | Pipeline registration with `dryRun: true`.                 |
| `tests/report-execution.test.ts` | Warning, no-warning, submission-failure, and option paths. |

## Setup

1. Copy the plugin into your repository:

   ```bash
   mkdir -p .devintern-code/steps
   cp examples/pipeline-plugins/report-execution/plugin.ts .devintern-code/steps/report-execution.ts
   bun add -d @getdevintern/code
   ```

2. Merge the `pipeline` block from `settings.json` into
   `.devintern-code/settings.json`.

3. Run the pipeline once with `dryRun` enabled and inspect the prepared
   payload in the step `data` (or the log line). When it looks right, set
   `dryRun` to `false`.

4. Sign in with `devintern login` so reports are tied to your account, or set
   `email` for anonymous reports. An explicit `accessToken` is also supported
   for custom deployments.

## Options

| Option         | Default  | Meaning                                                           |
| -------------- | -------- | ----------------------------------------------------------------- |
| `on`           | `"warn"` | `warn` reports when warnings exist; `always` reports every run.   |
| `dryRun`       | `true`   | Prepare and log without sending.                                  |
| `includeLogs`  | `false`  | Attach the worker's captured log tail.                            |
| `evidenceFile` | —        | File under `context.workingDir` attached as evidence (16 KB cap). |
| `email`        | —        | Contact address for anonymous reports.                            |
| `endpoint`     | —        | Override `DEVINTERN_REPORT_URL`.                                  |
| `accessToken`  | stored   | Explicit token override.                                          |
| `fetchImpl`    | global   | Injectable transport for tests and custom deployments.            |

## Walkthrough

Warnings — a step records a warning (for example `verify` with
`onFail: "warn"`), and `report-execution` prepares a payload:

```text
🐞 report-execution: prepared 4.2 KB (0 log attachment(s)); dry run, not sent
```

The result is available to later steps:

```ts
const record = context.results.find((entry) => entry.step === "report-execution");
const data = record?.result.data as { report?: { reportId: string } } | undefined;
```

No warnings — the step returns `{ kind: "continue" }` without preparing
anything. With `on: "always"` it reports regardless.

Submission failure — the step returns a `warn` with the error and the run
continues. Reporting must never be the reason delivery stops.

## Validate the example

```bash
bun run examples/pipeline-plugins/run-tests.ts report-execution
```
