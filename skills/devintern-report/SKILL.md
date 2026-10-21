---
name: devintern-report
description: Diagnose a DevIntern CLI or worker failure and file a redacted bug report with `devintern report`. Use when DevIntern crashes, a task run fails unexpectedly, or the user asks to report a bug.
---

# Report a DevIntern bug

Use `devintern report` to file a defect in DevIntern Code, the worker, a pipeline plugin, or an agent integration. The command collects a redacted diagnostic bundle, shows a preview, and submits only after consent.

Reporting is for product defects. Missing credentials, a tracker outage, an uninstalled agent CLI, a usage limit, or a failed verification check are configuration or user-code issues: fix those first or point to the relevant guide instead of filing a report.

## Confirm the command exists

Check `devintern report --help` before using flags. If the installed CLI does not have the command, say so and suggest upgrading `@getdevintern/code`; do not simulate a report or paste logs into a public issue.

## Diagnose before filing

- Run `devintern --version` and `devintern doctor`.
- Read the failing output and the relevant docs page. For tracker, agent, relay, or workspace problems, check [configuration](https://devintern.com/docs/code/configuration), [worker](https://devintern.com/docs/code/worker), and [relay](https://devintern.com/docs/code/relay).
- Try a minimal, read-only reproduction when possible. Do not re-run a destructive or non-idempotent command just to reproduce.
- If the failure is clearly configuration, help fix it and stop. File a report only when the behavior contradicts the docs or looks like a product crash.

## Collect evidence safely

Capture the failing output to a unique temporary file instead of pasting it into chat:

```bash
devintern PROJ-123 --create-pr 2>&1 | tee /tmp/devintern-report-UNIQUE.log
```

Then attach the relevant run and log:

```bash
devintern report --last --log /tmp/devintern-report-UNIQUE.log
```

Never place `.env` contents, session files, tokens, task descriptions, prompts, diffs, or customer data in the title, description, or a log file you attach. The command redacts common secrets, but it cannot recognize every proprietary value.

Prefer `--last`, `--task <KEY>`, or `--run <id>` over describing a run from memory. Add `--share-identifiers` only when the user agrees to include the task key and repository slug; the default is redacted.

## Draft the report

Write a title that names the component and symptom, for example `worker stops after second harness failover` or `devintern report --from fails with 413`.

The description should include:

- The exact command, with secrets removed
- Expected behavior and what happened instead
- Whether it reproduces, and any workaround
- Relevant version, harness, tracker, and OS details (the command adds most of these)
- The smallest useful log excerpt, attached through `--log` rather than pasted

Keep task content out. Refer to a ticket by a redacted placeholder unless the user explicitly approves sharing it.

## Preview and get consent

Prepare the payload once, then review and send exactly that payload:

```bash
devintern report \
  --title "worker stops after second harness failover" \
  --body-file /tmp/devintern-report-notes.md \
  --last --log /tmp/devintern-report-UNIQUE.log \
  --save /tmp/devintern-report-payload.json

devintern report --from /tmp/devintern-report-payload.json --print
```

Summarize for the user what will be attached (environment, run summary, log sizes) and what was deliberately omitted. Do not dump the full JSON into the conversation; show the title and description and describe the rest. Ask for approval before submitting.

Signed-in users get account follow-up. Anonymous reports need a contact address:

```bash
devintern report --from /tmp/devintern-report-payload.json --email user@example.com --yes
```

Only use `--yes` after the user approved the preview. For scripts, add `--json`; stdout is then a single result object.

If submission fails, the command saves the report locally and prints a `--from` retry path. Keep that path and tell the user; do not discard it. If the endpoint is unreachable and the user cannot wait, `--save` the payload and hand over the file instead.

## Report the outcome

Return the short report id from the command, what was attached, what was omitted, and whether the report is submitted or saved locally. Do not promise a fix or a timeline.

## Avoid

- Filing reports for missing credentials, usage limits, or user-code verification failures
- Creating a public GitHub issue containing logs, task content, or repository identifiers
- Pasting the full `--print` payload into chat
- Running the command with `--yes` before showing the preview
- Reporting another person's data without explicit permission
- Inventing flags, endpoints, or report ids when the installed CLI lacks the command

For payload details, automatic-report settings, and retention, see [Reporting bugs](https://devintern.com/docs/code/reporting-bugs).
