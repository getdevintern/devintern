---
title: "Reporting Bugs"
sidebarLabel: "Bug Reports"
description: "File a redacted DevIntern bug report from the CLI or the dashboard, attach a relevant run, and preview the evidence before sending."
section: "Automation Reference"
order: 2
dateModified: 2026-11-18
tags: ["troubleshooting", "bug-report", "diagnostics", "privacy"]
---

# Reporting Bugs

`devintern report` files a bug report for DevIntern itself: the CLI, worker, pipeline, or agent integration. It gathers a redacted diagnostic bundle and shows exactly what will be sent before anything leaves your machine.

Use it when a run completes with incorrect behavior, DevIntern crashes, a run fails in a way the output does not explain, or `devintern doctor` reports a problem that looks like a product defect. For tracker credentials, missing agent CLIs, usage limits, and failed verification checks, start with [doctor](advanced-settings.md#readiness-check) and the relevant integration guide instead.

## File a report

```bash
devintern report
```

The command prompts for a title and a multiline description, shows a preview, and asks before submitting. Signed-in users get follow-up through their account; anonymous reports require a contact email:

```bash
devintern report --email you@example.com
```

Reporting never requires a license, and it works when sign-in is broken.

## Attach a failed run

`--last` attaches the most recent failed or escalated run: status, failed stage, duration, warnings, and the recorded failure reason.

```bash
devintern report --last
devintern report --task PROJ-123
devintern report --run 482
```

For worker runs, a tail of the captured logs is attached automatically. For an interactive run, save the terminal output and pass it explicitly:

```bash
devintern PROJ-123 --create-pr 2>&1 | tee /tmp/devintern-run.log
devintern report --last --log /tmp/devintern-run.log
```

Log attachment is bounded (64 KB per source) and credentials are masked. Pass `--no-logs` to omit log text, or `--no-diagnostics` to skip run metadata and logs.

## Report from the dashboard

The [worker dashboard](dashboard.md) can file the same report without a terminal. Open the run and choose **Report a problem**.

1. Enter a title and describe what you expected and what happened. Do not paste secrets, credentials, or customer data. Leave **Share identifiers** off unless the task key and repository slug help triage (it matches `--share-identifiers`).
2. Choose **Preview report** to see the full redacted payload, collected like `devintern report --run <id>`. Nothing is sent yet.
3. Choose **Send report**. Anonymous reports need a contact email here.

A preview expires after 15 minutes. If the endpoint cannot be reached, the report is saved locally and the dialog shows the `devintern report --from <path>` command to retry later.

## Preview, save, and retry

```bash
# Show the exact redacted payload without sending it
devintern report --last --print

# Write it to a file instead
devintern report --last --save /tmp/report.json

# Send a saved report later (for example after restoring connectivity)
devintern report --from /tmp/report.json

# Inspect local report history
devintern report list
devintern report show 8f2a1c
```

Every report is saved to `.devintern-code/reports/` before sending. If sending fails, the command prints the `--from` path to retry. Sent reports are kept locally for 30 days.

## What is sent

The payload contains:

- CLI version, install kind, OS/arch, runtime versions, tracker type, harness name, and whether the run was automated
- The failing run's status, failed stage, duration, warnings, and reason
- Bounded log tails you explicitly attach or that the worker captured
- A stable failure fingerprint used to group duplicates

Task descriptions, prompts, agent transcripts, diffs, source files, and `.env` contents are not collected. Known credentials, checkout and home paths, task keys, and the repository slug are masked; `--share-identifiers` keeps task and repository identifiers. Redaction cannot recognize every secret, so review the preview of your description and attached logs before submitting.

Crashes are already captured through Sentry. A manual report adds what an exception cannot: what you expected, how to reproduce it, and wrong results from runs that succeeded. A manual report is sent only when you confirm (or pass `--yes`). Task runs send nothing unless you turn on [automatic defect reports](#automatic-defect-reports).

To send reports to your own support intake, set `DEVINTERN_REPORT_URL`, or pass `--endpoint <url>` for one command.

## Automatic defect reports

Automatic defect reports are off by default. When you turn them on, DevIntern checks each failed task run on your machine and reports the failure only when it finds a defect in DevIntern itself:

```bash
# .devintern-code/.env (or the worker's environment)
DEVINTERN_AUTO_REPORT=1
```

| Failure | Result |
| --- | --- |
| Unhandled programming error (for example `TypeError`) raised in DevIntern's own code | Reported |
| Tracker, code host, or network errors, credentials, usage limits, agent exits, merge conflicts, failed verification | Not reported |
| Anything else, including errors raised in dependencies, plugins, or your project | Not reported (inconclusive) |

An automatic report goes to the same DevIntern intake as `devintern report` (or to `DEVINTERN_REPORT_URL`), never to your task's repository or tracker. It contains the error type, a cleaned-up error message, DevIntern stack frames, the failed step, and the environment block described above. Logs, run history, task content, repository details, and credentials are left out.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DEVINTERN_AUTO_REPORT` | off | `1`, `true`, `yes`, or `on` turns automatic reports on |
| `DEVINTERN_REPORT_EMAIL` | none | Contact address used when you are not signed in. Without a sign-in or this address, defects are found but not sent |

The run output prints whether a report was sent, with a link to it. The failed run in the [dashboard](dashboard.md) gets a **DevIntern issue report** stage with the same information. `devintern report list` shows automatic reports next to manual ones; their titles start with `[auto]`. The same defect is sent once per 30 days, and later failures link to the existing report. If sending fails, the report is saved locally and resent the next time the defect occurs; you can also resend it with the printed `devintern report --from <path>` command. Turning reports on never changes the result of the failed run.

## Report with a coding agent

Install the [devintern-report skill](agent-skills.md) and ask your agent to report the failure. The skill checks whether the problem is a DevIntern defect, gathers evidence without exposing secrets, and previews the payload before submitting.

```bash
bunx skills add getdevintern/devintern --skill devintern-report --agent codex
```

## Privacy

Bug reports are private to DevIntern. They are not posted to public GitHub issues. A maintainer may promote a redacted summary to an internal issue and link it back to the stored report.

See [devintern.com/privacy](https://devintern.com/privacy/) for data handling and retention.
