---
title: "Reporting Bugs"
sidebarLabel: "Bug Reports"
description: "File a redacted DevIntern bug report from the CLI or the dashboard, attach a relevant run, and preview the evidence before sending."
section: "Automation Reference"
order: 2
dateModified: 2026-11-25
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

The [worker dashboard](dashboard.md) can file the same report without a terminal. Open the run and choose **Report a problem**. For a problem that is not tied to one run, choose **Report a bug** at the bottom of the sidebar instead: it attaches your environment and recent worker logs, but no run.

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

Every report is saved to `~/.devintern/state/code/reports/` before sending. If sending fails, the command prints the `--from` path to retry. Sent reports are kept locally for 30 days.

## What is sent

The payload contains:

- CLI version, install kind, OS/arch, runtime versions, tracker type, harness name, and whether the run was automated
- The failing run's status, failed stage, duration, warnings, and reason
- Bounded log tails you explicitly attach or that the worker captured
- A stable failure fingerprint used to group duplicates

Task descriptions, prompts, agent transcripts, diffs, source files, and `.env` contents are not collected. Known credentials, checkout and home paths, task keys, and the repository slug are masked; `--share-identifiers` keeps task and repository identifiers. Redaction cannot recognize every secret, so review the preview of your description and attached logs before submitting.

Crashes are already captured through Sentry. A manual report adds what an exception cannot: what you expected, how to reproduce it, and wrong results from runs that succeeded. A report is sent only when you confirm (or pass `--yes`); task runs never send one.

To send reports to your own support intake, set `DEVINTERN_REPORT_URL`, or pass `--endpoint <url>` for one command.

## Report with a coding agent

Install the [devintern-report skill](agent-skills.md) and ask your agent to report the failure. The skill checks whether the problem is a DevIntern defect, gathers evidence without exposing secrets, and previews the payload before submitting.

```bash
bunx skills add getdevintern/devintern --skill devintern-report --agent codex
```

## Public issues and feature requests

For bugs that need no logs or run details, such as a docs mistake or an install problem, you can open a [public bug report](https://github.com/getdevintern/devintern/issues/new?template=bug_report.yml) on GitHub instead. Post only short, redacted excerpts there.

Suggest features with the [feature request form](https://github.com/getdevintern/devintern/issues/new?template=feature_request.yml), or choose **Request a feature** in the dashboard sidebar.

## Privacy

Reports sent with `devintern report` or the dashboard are private to DevIntern. They are not posted to public GitHub issues. A maintainer may promote a redacted summary to an internal issue and link it back to the stored report.

See [devintern.com/privacy](https://devintern.com/privacy/) for data handling and retention.
