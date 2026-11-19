---
title: "Markdown File Tasks"
description: "Use local markdown files as task input for @devintern/code, no task tracker required"
section: "Automation"
order: 6
sidebarHidden: true
dateModified: 2026-11-18
---

# Markdown File Tasks

Run `devintern` against local Markdown files instead of tracker tickets. This suits one-off tasks, local specs, and projects without a task tracker, and it is the fastest way to try the [worker](./worker.md#polling-mode).

There are two modes:

- **File path mode:** pass `.md` paths directly. No tracker credentials or `TASK_TRACKER` setting needed.
- **Tracker mode:** set `TASK_TRACKER=markdown` and pass short task keys resolved from a tasks directory. This mode supports `--query` and the worker.

## File path mode

```bash
devintern ./tasks/feature-spec.md --create-pr
devintern ./epic.md ./subtask-a.md ./subtask-b.md   # processed in order
devintern PROJ-123 ./extra-context.md               # mix with tracker keys
```

An argument ending in `.md` or containing a path separator is treated as a file; anything else goes to the configured tracker. Relative paths resolve from the current directory. When every argument is a file, tracker credentials are not checked.

## Tracker mode (`TASK_TRACKER=markdown`)

| Variable             | Required | Description                         |
| -------------------- | -------- | ----------------------------------- |
| `TASK_TRACKER`       | Yes      | `markdown`                          |
| `MARKDOWN_TASKS_DIR` | Yes      | Directory that holds the task files |

```bash
devintern my-feature --create-pr   # resolves {MARKDOWN_TASKS_DIR}/my-feature.md, or a file whose key: is my-feature
devintern --query "status=todo" --create-pr
devintern --query 'status="In Progress" type=bug login' --create-pr
```

`--query` takes space-separated `key=value` frontmatter filters (case-insensitive; quote values with spaces), plus optional free text matched against titles. Files without frontmatter only match queries with no filters. For the worker, put the filter in `[defaults].task_query`.

## File format

The whole file is passed to the agent. Frontmatter is optional:

```markdown
---
key: my-feature
status: To Do
type: Feature
---

# Add user profile page

Add a profile page at `/profile` that shows the signed-in user's name and avatar.
```

| Field        | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `key`        | Task key for the branch (`feature/{key}`) and output directory. Defaults to the filename stem      |
| `status`     | If present, updated in place: `In Progress` before the agent runs, `Done` after success, left `In Progress` on failure |
| `type`       | Informational; defaults to `Task`                                                                 |
| `created_at` | Informational                                                                                     |

The title is the first `# H1` heading, or the filename stem. If the file has no `## Implementation Instructions` section, a short default prompt is appended; add your own section to override it. Special characters in the key become hyphens in the branch name.

Since `status` is edited in place, commit the file if you want to track the transitions.

## What is supported

Both modes support `--create-pr`, `--auto-review`, `--skip-clarity-check`, `--no-git`, and status updates. Batch `--query` works only in tracker mode. Tracker comments, story-point estimation, and attachments are not available for Markdown tasks.

## Troubleshooting

| Symptom                                                               | Fix                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `File not found`                                                      | Check the path; relative paths resolve from the current directory.          |
| `File appears to be binary`                                           | The file contains a null byte; use a plain-text `.md` file.                  |
| `Missing required markdown environment variable: MARKDOWN_TASKS_DIR`  | Set `MARKDOWN_TASKS_DIR` when `TASK_TRACKER=markdown`.                        |
| Status is not updated                                                 | Add a `status:` field to the frontmatter.                                    |
| Branch name looks wrong                                               | Set `key:` in the frontmatter, or rename the file.                           |
