---
title: "Pipeline Artifacts"
sidebarLabel: "Artifacts"
description: "Capture, inspect, and publish files produced by DevIntern pipeline steps."
section: "Automation"
order: 6
sidebarHidden: true
dateModified: 2026-11-18
---

# Pipeline artifacts

Artifacts are files that pipeline steps register for review: verification reports, auto-review feedback, change explanations, screenshots. You can inspect them in the dashboard and choose which ones appear on the pull request. Nothing is published unless you select it.

## What gets captured

- Built-in `verify` registers `verification` (the JSON verdict) and `verification-prompt`.
- `auto-review` registers each iteration's feedback and prompt, plus an `auto-review` summary.
- [Plugin steps](./pipeline-plugins.md#artifacts-from-steps) register their own files with `context.artifacts.addFile({ key, path, title, kind, mediaType })`.

| Field       | Rules                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `key`       | 1–128 letters, numbers, dots, underscores, or hyphens, starting with a letter or number. Used to select it for publication. |
| `path`      | Relative to `context.workingDir`; must be inside `context.workingDir` or `context.outputDir`.             |
| `kind`      | `explanation`, `verification`, `image`, `report`, or `debug`.                                             |
| `mediaType` | Controls the preview, for example `text/markdown` or `image/png`.                                         |

Each registration saves a snapshot tied to the run, step, and commit, so later edits, retries, and loopbacks never overwrite earlier evidence. Files are limited to 32 MiB and 200 snapshots per run. Text is ANSI-stripped and secrets are redacted. A capture failure only produces a warning; it never fails the run.

Snapshots are stored under `~/.devintern/artifacts/` (or under `DEVINTERN_WORKSPACE_DIR` when set), so they outlive task worktrees and `/tmp` output. There is no automatic cleanup.

## Where to see it

Open a run in the [dashboard](./dashboard.md). Run details list the artifacts registered by that attempt, including runs without a ticket key. Markdown, text, JSON, and PNG/JPEG/GIF/WebP images preview inline (text previews show the first 512 KiB); other files, including HTML and SVG, are download-only. The dashboard and worker must share the same workspace directory.

## Choose what appears on the PR

Publication is off by default. Add an `artifacts` block next to `steps` and `plugins` in the pipeline definition (inside `pipeline` in `.devintern-code/settings.json`):

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

| Presentation | Renders                                                     | Needs an uploader |
| ------------ | ----------------------------------------------------------- | ----------------- |
| `inline`     | The text in the comment body (non-Markdown text is fenced). | No                |
| `collapsed`  | The text inside a collapsible section.                      | No                |
| `embed`      | An image from its uploaded URL.                             | Yes               |
| `link`       | A link to the uploaded file.                                | Yes               |

`finalize` posts the latest snapshot of each selected key to one managed **Artifacts & verification** comment on the GitHub PR and updates it on later runs. It never edits human comments or the PR description. Long comments drop whole sections rather than cutting them mid-way, and missing artifacts or upload URLs are noted in the comment. Publication problems are warnings and do not fail the run. GitLab and Bitbucket comment publication is not supported yet; artifacts are still captured and visible in the dashboard.

### Reference artifacts from Markdown

Inside a Markdown artifact, refer to other artifacts by key instead of by path:

```markdown
![After the change](artifact:screenshot)
[Download browser trace](artifact:browser-trace)
```

The dashboard links these to its local copies. On the PR they become uploaded URLs, so the referenced artifact must also be selected with `embed` or `link`. Unresolved references are shown as plain text.

## Upload files

`embed` and `link` need the file hosted somewhere reviewers can reach. Set `uploader` to the built-in `"files-sdk"` uploader, or to your own module. Only artifacts selected as `embed` or `link` are uploaded, uploaded URLs are reused on later publications, and upload failures never block PR creation.

### Files SDK uploader

The built-in uploader supports Cloudflare R2 and AWS S3 with no extra install:

```json
{
  "artifacts": {
    "publish": {
      "destination": "pr-comment",
      "uploader": "files-sdk",
      "select": [{ "key": "explanation-image", "presentation": "embed" }]
    }
  }
}
```

Configure it in the workspace `.env` (default `~/.devintern/.env`) or a repository `env_file`, then restart the worker:

```dotenv
# r2 or s3
DEVINTERN_ARTIFACT_PROVIDER=r2
# R2 only
DEVINTERN_ARTIFACT_ACCOUNT_ID=<32-character-cloudflare-account-id>
DEVINTERN_ARTIFACT_BUCKET=review-artifacts
DEVINTERN_ARTIFACT_ACCESS_KEY_ID=<access-key-id>
DEVINTERN_ARTIFACT_SECRET_ACCESS_KEY=<secret-access-key>
DEVINTERN_ARTIFACT_PUBLIC_BASE_URL=https://artifacts.example.com/
```

| Variable                          | Default               | Notes                                                       |
| --------------------------------- | --------------------- | ----------------------------------------------------------- |
| `DEVINTERN_ARTIFACT_KEY_PREFIX`   | `devintern/artifacts` | Prefix for object keys and URLs.                            |
| `DEVINTERN_ARTIFACT_REGION`       | `us-east-1`           | S3 only. R2 always uses `auto`.                             |
| `DEVINTERN_ARTIFACT_ENDPOINT`     | AWS                   | S3 only. Points at another S3-compatible service.           |

Use credentials created for this bucket; for R2 that means R2 S3 API keys, not a Cloudflare API token. Ambient AWS credentials are never used. Create the bucket and make `DEVINTERN_ARTIFACT_PUBLIC_BASE_URL` (for R2, a public custom domain) readable by reviewers yourself; DevIntern does not change bucket visibility or create signed links. Missing or invalid settings fail the run before implementation starts.

Workspace values apply to every repository; a repository's `env_file` or `[repos.env]` can override them. Worker tasks do not read a checkout's `.devintern-code/.env`, but direct CLI runs do. Keep these files out of git.

The [PNG explainer example](https://github.com/getdevintern/devintern/tree/main/examples/pipeline-plugins/pr-explainer-image) shows generation, capture, upload, and the PR comment end to end.

### Custom uploader

For other storage, point `uploader` at a module path or package name (resolved like [plugins](./pipeline-plugins.md#loading-plugins-and-resolving-paths)). It must default-export an object with `upload(artifact, bytes): Promise<{ url: string }>`. To reuse the Files SDK with another backend, use the exported factory:

```ts
import { Files } from "files-sdk";
import { bunS3 } from "files-sdk/bun-s3";
import { createFilesArtifactUploader } from "@getdevintern/code/pipeline";

export default createFilesArtifactUploader({
  files: new Files({ adapter: bunS3({ bucket: "review-artifacts" }) }),
  publicBaseUrl: "https://artifacts.example.com/",
  keyPrefix: "devintern/artifacts",
});
```

Add `files-sdk` to that project's dependencies (`bun add files-sdk`). The factory accepts `timeoutMs` (default `30000`, max `300000`). Return durable URLs: short-lived signed URLs stop working in existing comments.

## Explainer plugins

The `pr-explainer-narrative` and `pr-explainer-visual` examples read the task, the final diff, and recorded verification results, ask the agent to explain the change, and register `explanation-narrative` and `explanation-visual`. Their example settings publish the narrative inline and the visual summary collapsed. Copy the files listed in each example's [README](https://github.com/getdevintern/devintern/tree/main/examples/pipeline-plugins), then add the step and the `select` entries to your pipeline. Failures in these steps are warnings only.
