---
title: "Markdown File Tasks"
description: "Use local markdown files as task input for @devintern/code, no task tracker required"
section: "Code"
order: 6
sidebarHidden: true
dateModified: 2026-07-03
---

# Markdown File Tasks

You can run `devintern` against a local markdown file instead of a Jira issue or Trello card. No PM credentials are required when every argument is a file path.

This is useful for one-off tasks, local specs, or projects that do not use an external task tracker.

## Direct file path mode

Pass one or more `.md` file paths (relative or absolute) directly as arguments:

```bash
# Single file
devintern ./tasks/feature-spec.md

# With PR creation
devintern ./tasks/feature-spec.md --create-pr

# Multiple files (processed in sequence)
devintern ./epic.md ./subtask-a.md ./subtask-b.md

# Skip branch creation
devintern ./tasks/feature-spec.md --no-git
```

Any argument ending in `.md` or containing a path separator (`/` or `./`) is treated as a file path. Jira and Trello keys that do not match are routed to the configured task tracker as normal, so you can mix both in one command:

```bash
# PM task + local file in one run
devintern PROJ-123 ./extra-context.md
```

When all arguments are file paths, `devintern` skips PM credential validation entirely so no `.devintern-code/.env` is needed for the task tracker section.

## Markdown file format

The file is passed directly to the agent. Optionally add YAML frontmatter to control the task key and status tracking:

```markdown
---
key: my-feature
status: To Do
type: Feature
---

# Add user profile page

Add a profile page at `/profile` that shows the signed-in user's name and avatar.

## Acceptance criteria

- Route `/profile` renders user name and avatar
- Redirects to `/login` when not authenticated
```

### Frontmatter fields

| Field        | Required | Description                                                                                                                            |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `key`        | No       | Task key used for the git branch name and output directory. Defaults to the filename stem (e.g. `feature-spec` for `feature-spec.md`). |
| `status`     | No       | Current status. When present, `devintern` updates it to `In Progress` before running the agent and to `Done` on success.               |
| `type`       | No       | Issue type label (informational only; defaults to `Task`).                                                                             |
| `created_at` | No       | Creation timestamp (informational only).                                                                                               |

Frontmatter is optional. A file with no frontmatter works fine: the filename stem is used as the task key and no status tracking is applied.

### Title extraction

The task title is taken from the first `# H1` heading in the file. If no H1 is present, the filename stem is used as the title.

### Implementation instructions

If the file does not already contain an `## Implementation Instructions` section, `devintern` appends a short prompt at the end of the content passed to the agent. You can include your own instructions in the file to override this.

## Git branch name

The branch is created as `feature/{key}` where `{key}` is:

1. The `key:` frontmatter value (if set), or
2. The filename stem (e.g. `my-task.md` produces `feature/my-task`)

Special characters are replaced with hyphens for git compatibility.

## Status tracking

When the frontmatter includes a `status:` field, `devintern` updates it in place:

- Set to `In Progress` just before the agent runs
- Set to `Done` after a successful run (detected by the presence of `implementation-summary.md`)
- Left as `In Progress` if the run fails or is incomplete

The file is edited in place, so commit it to version control if you want to track these transitions.

## TASK_TRACKER=markdown mode

For projects that store all task files in a single directory, you can set the tracker to `markdown` and pass short task keys instead of file paths:

```bash
# .devintern-code/.env
TASK_TRACKER=markdown
MARKDOWN_TASKS_DIR=/path/to/tasks
```

Then run:

```bash
devintern my-feature --create-pr
```

`devintern` resolves `my-feature` to `{MARKDOWN_TASKS_DIR}/my-feature.md` (or uses the `key:` frontmatter field to find the file). All standard flags work the same way.

`MARKDOWN_TASKS_DIR` is required when `TASK_TRACKER=markdown`.

### Batch processing with --query

Select multiple task files by frontmatter fields, with optional free text matched against titles:

```bash
devintern --query "status=todo" --create-pr
devintern --query 'status="In Progress" type=bug login' --create-pr
```

Each space-separated `key=value` pair must match the file's frontmatter (values compared case-insensitively; quote values containing spaces). Files without frontmatter only match queries with no filters.

## What is and is not supported

| Feature                  | File path mode                     | TASK_TRACKER=markdown     |
| ------------------------ | ---------------------------------- | ------------------------- |
| No PM credentials needed | Yes                                | Yes                       |
| Status field auto-update | Yes (if frontmatter has `status:`) | Yes                       |
| Git branch creation      | Yes                                | Yes                       |
| `--create-pr`            | Yes                                | Yes                       |
| `--auto-review`          | Yes                                | Yes                       |
| `--skip-clarity-check`   | Yes                                | Yes                       |
| `--no-git`               | Yes                                | Yes                       |
| Batch `--query`          | No                                 | Yes (frontmatter filters) |
| Post comments to tracker | No                                 | No                        |
| Story point estimation   | No                                 | No                        |
| Attachments              | No                                 | No                        |

## Troubleshooting

**"File not found"**

Check that the path is correct and the file exists. Relative paths are resolved from the current working directory.

**"File appears to be binary"**

The file contains a null byte. Ensure it is a plain text `.md` file.

**"Missing required markdown environment variable: MARKDOWN_TASKS_DIR"**

Set `MARKDOWN_TASKS_DIR` in `.devintern-code/.env` when using `TASK_TRACKER=markdown`.

**Status is not updated after the run**

The frontmatter must contain a `status:` field. A file without a `status:` field is processed normally but the field is not written.

**Branch name looks wrong**

Check the `key:` field in the frontmatter. If no `key:` is set, the branch is derived from the filename. Rename the file or add a `key:` field to control it explicitly.
