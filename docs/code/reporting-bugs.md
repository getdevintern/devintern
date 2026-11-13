---
title: "Reporting Bugs"
sidebarLabel: "Bug Reports"
description: "File a redacted DevIntern bug report from the CLI, attach a relevant run, and preview the evidence before sending."
section: "Automation Reference"
order: 2
dateModified: 2026-10-21
tags: ["troubleshooting", "bug-report", "diagnostics", "privacy"]
---

# Reporting Bugs

`devintern report` files a bug report for DevIntern itself: the CLI, worker, pipeline, or agent integration. It gathers a redacted diagnostic bundle and shows exactly what will be sent before anything leaves your machine.

Use it when a run completes with incorrect behavior, DevIntern crashes, a run fails in a way the output does not explain, or `devintern doctor` reports a problem that looks like a product defect. For tracker credentials, missing agent CLIs, usage limits, and failed verification checks, start with [doctor](configuration.md#readiness-check) and the relevant integration guide instead.

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

Run history comes from the worker's local database. When the worker's log capture files exist, a bounded tail is included automatically. For an interactive run, capture the terminal output yourself and pass it explicitly:

```bash
devintern PROJ-123 --create-pr 2>&1 | tee /tmp/devintern-run.log
devintern report --last --log /tmp/devintern-run.log
```

Log attachment is bounded (64 KB per source) and credentials are masked.

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

Every submission attempt is written to `.devintern-code/reports/` first. If the endpoint is unavailable, the report stays pending and the command prints the exact `--from` retry path. A successful send keeps the local copy for 30 days as an audit trail.

## What is sent

The payload contains:

- CLI version, install kind, OS/arch, runtime versions, tracker type, harness name, and whether the run was automated
- The failing run's status, failed stage, duration, warnings, and reason
- Bounded log tails you explicitly attach or that the worker captured
- A stable failure fingerprint used to group duplicates

The collector does not deliberately read task descriptions, prompts, agent transcripts, diffs, source files, or `.env` contents. Attached logs and free-text fields can still contain sensitive content: review the preview and remove anything private before submitting. Known credentials, the current checkout and home paths, task keys, and the detected repository slug are masked; `--share-identifiers` keeps task and repository identifiers.

Report descriptions and log text pass through redaction before submission. Redaction cannot recognize every secret or proprietary value.

## How this complements Sentry

DevIntern already captures exceptions through Sentry. Manual reports add the context an exception cannot provide: expected behavior, reproduction steps, impact, and incorrect results from a run that completed successfully. Describe those details in the report, and attach the relevant run when available.

Warnings and failed checks in user code are not automatically DevIntern defects. Diagnose them before filing a report. The report command sends only when you confirm submission (or explicitly pass `--yes`); task execution does not submit bug reports to this endpoint.

For a custom support intake, set `DEVINTERN_REPORT_URL` to its report endpoint.

## Report with a coding agent

Install the [devintern-report skill](agent-skills.md) and ask your agent to report the failure. The skill checks whether the problem is a DevIntern defect, gathers evidence without exposing secrets, and previews the payload before submitting.

```bash
bunx skills add getdevintern/devintern --skill devintern-report --agent codex
```

## Privacy

Bug reports are private to DevIntern. They are not posted to public GitHub issues. A maintainer may promote a redacted summary to an internal issue and link it back to the stored report.

See [devintern.com/privacy](https://devintern.com/privacy/) for data handling and retention.
