---
title: "Pipeline Artifacts"
sidebarLabel: "Artifacts"
description: "Capture, inspect, and publish files produced by DevIntern pipeline steps."
section: "Automation"
order: 6
dateModified: 2026-10-16
---

# Pipeline artifacts

Artifacts are files deliberately registered by a pipeline step for inspection.
Capture, dashboard presentation, uploads, and PR publication share one contract.
A filename or plugin name never opts a file into publication.

## Capture

Built-in verification registers `verification` (JSON) and `verification-prompt`
(text). Auto-review registers each iteration's feedback and prompt plus an
`auto-review` summary. Plugins use the same API:

```ts
await context.artifacts.addFile({
  key: "explanation-narrative",
  path: reportPath,
  title: "Change explanation",
  kind: "explanation",
  mediaType: "text/markdown",
});
```

Keys are 1–128 characters: letters, numbers, dots, underscores, and hyphens,
starting with a letter or number. Kinds are `explanation`, `verification`,
`image`, `report`, and `debug`. Media types identify how to preview content.
Relative paths resolve against `context.workingDir`. Source files must be within
`context.workingDir` or `context.outputDir`.

The runtime immediately snapshots the file and records its run ID, producing
step, step execution number, current commit SHA when available, timestamp,
size, and SHA-256 checksum. Later writes to the original file cannot change
that snapshot. Registration before a step fails or requests a loopback preserves
that attempt's evidence. Reusing a logical key creates another snapshot.
`data` in a step result remains available for programmatic results; artifact
bodies do not need to be duplicated there.

Use `context.artifacts.list()` to inspect captured metadata and
`context.artifacts.readText(id)` to read a bounded text artifact, or
`readBytes(id)` for binary data. The explainer examples read registered
verification reports to ground their explanations in recorded evidence.

Capture failures warn and return `null`; they never turn a passing implementation
into a failed run. Files are limited to 32 MiB and 200 snapshots per run. Text
is ANSI-stripped and secret-redacted before storage. Binary files retain their
original bytes; selecting them for upload is an explicit publication choice.

## Dashboard and storage

Metadata lives in the run database. Snapshots live under
`~/.devintern/artifacts/<database-namespace>/` (or the overridden
`DEVINTERN_WORKSPACE_DIR`), outside disposable task worktrees and `/tmp` output.
Run detail lists only registered outputs belonging to that exact attempt,
including runs without a ticket key. Debug-directory scanning is not used.

The dashboard previews Markdown, text/JSON, and PNG/JPEG/GIF/WebP images. Other
files can be downloaded. Text previews show the first 512 KiB; larger artifacts
remain downloadable. HTML and SVG are downloaded rather than served as active
pages. Missing files remain listed as expired or missing; metadata is retained.
Automatic artifact retention is not configured by this feature.

Endpoints:

- `GET /api/runs/:id/artifacts`: registered metadata in capture order.
- `GET /api/runs/:id/artifacts/:artifactId`: bounded text preview, or `null`
  content for binary files.
- `GET /api/runs/:id/artifacts/:artifactId/file`: safe raster preview or download.
  Add `?download=1` to force download.

Artifact IDs are opaque and scoped to their run; filenames are not API keys.
The dashboard and worker must share the database and workspace artifact storage.

## Select what appears on the PR

Publication is disabled by default. Add this alongside `steps` and `plugins`
in a pipeline definition (inside `pipeline` for repository settings):

```json
{
  "artifacts": {
    "publish": {
      "destination": "pr-comment",
      "select": [
        { "key": "explanation-narrative", "presentation": "inline" },
        { "key": "explanation-visual", "presentation": "collapsed" },
        { "key": "verification", "presentation": "collapsed" }
      ]
    }
  }
}
```

`finalize` publishes the latest snapshot of each selected key to one managed
**Artifacts & verification** GitHub comment. Later runs update that comment,
including when a PR already exists. Author matching and a hidden marker prevent
editing human comments. The PR description is unaffected. The comment identifies
the run and each output's producing execution/commit. Earlier snapshots remain
available in the dashboard.

`inline` and `collapsed` render text; non-Markdown text is fenced. `embed` and
`link` require an uploaded URL. Missing artifacts, oversized previews, and
missing upload URLs are reported explicitly. Comments have a bounded preview
budget; complete Markdown sections are omitted when needed instead of being
cut midway. Publication failures warn and are recorded separately from run
success. GitLab and Bitbucket comment publication currently report a skipped
status; local capture and dashboard access still work.

## Upload files

GitHub comments contain Markdown; binary upload is a separate operation.
Configure a trusted module implementing `ArtifactUploader`:

```json
{
  "artifacts": {
    "publish": {
      "destination": "pr-comment",
      "uploader": "./adapters/artifact-storage.ts",
      "select": [
        { "key": "explanation-narrative", "presentation": "inline" },
        { "key": "screenshot", "presentation": "embed" },
        { "key": "browser-trace", "presentation": "link" }
      ]
    }
  }
}
```

The module must default-export an object implementing this interface:

```ts
import type { RunArtifact } from "@getdevintern/code/pipeline";

interface ArtifactUploader {
  upload(artifact: RunArtifact, bytes: Uint8Array): Promise<{ url: string }>;
}
```

Relative module paths resolve next to a workspace pipeline file, or against the
repository for repository settings. Installed package names are supported too.
Uploader exports are validated before implementation starts. No storage backend
or hosting credentials are bundled. The adapter owns access control, retention,
and URL lifetime, and should use the artifact checksum or ID for idempotent
object naming. Return a durable HTTP(S) URL that intended reviewers can access;
short-lived signed URLs will eventually expire in existing comments.

Only explicitly selected `embed`/`link` artifacts are uploaded. Successful URLs
are persisted per artifact and uploader module, so publishing again can reuse
them. Upload failures are recorded independently and do not block PR creation.

## Reference files from Markdown

Use logical artifact references instead of absolute paths:

```markdown
![After the change](artifact:screenshot)
[Download browser trace](artifact:browser-trace)
```

The dashboard resolves these to local artifact endpoints for the same commit.
PR comments resolve them to uploaded URLs. Referenced files must also be selected
for `embed` or `link` publication to be uploaded. Unavailable references become
plain text; local dashboard URLs are never inferred as remote upload locations.

## Explainer plugins

The narrative and visual examples share `explainer.ts`. Each gathers the task,
final diff, and recorded verification evidence, runs the configured agent, and
writes Markdown under `context.outputDir`.

The narrative example registers `explanation-narrative`; the visual example
registers `explanation-visual`. Their step-result `data` contains the source
`path`, while the artifact registry stores the report content and metadata.
Both artifacts appear in the run's dashboard. Their example pipeline settings
select narrative output inline and visual output collapsed in the managed PR
comment.

Copy the plugin wrapper, shared scaffold, and prompt files as described in each
example's README, then configure its pipeline step and publication selection.
Generation and capture failures remain advisory.
