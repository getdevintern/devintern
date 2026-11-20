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

Publication is off by default. Add an `artifacts` block next to `steps` and `plugins` in the pipeline definition (inside `pipeline` in your workspace `pipeline_file`):

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

Add `"optional": true` to a selection when its step captures only on some runs, such as screenshots taken only for UI changes. If nothing was captured under that key, its section is left out of the comment instead of reading "Not captured."

`finalize` posts the latest snapshot of each selected key to one managed **Artifacts & verification** comment (a note on GitLab merge requests) and updates it on later runs, including on PRs and MRs that already existed. It only updates a marked comment written by the same account, and never edits human comments or the PR/MR description. Long comments drop whole sections rather than cutting them mid-way, and missing artifacts, missing upload URLs, and upload failures are noted in the comment. Publication problems are warnings and do not fail the run. Bitbucket comment publication is not supported yet; artifacts are still captured and visible in the dashboard.

### Reference artifacts from Markdown

Inside a Markdown artifact, refer to other artifacts by key instead of by path:

```markdown
![After the change](artifact:screenshot)
[Download browser trace](artifact:browser-trace)
```

The dashboard links these to its local copies. On the PR they become uploaded URLs, so the referenced artifact must also be selected with `embed` or `link`. Unresolved references are shown as plain text.

## Upload files

`embed` and `link` need the file hosted somewhere reviewers can reach. Set `uploader` to a built-in uploader or to your own module:

| `uploader`  | Hosts files on                                           | Setup                                  |
| ----------- | -------------------------------------------------------- | -------------------------------------- |
| `code-host` | GitHub or GitLab, whichever the `origin` remote points to | Existing code-host credentials         |
| `github`    | GitHub native attachments (github.com only)              | `GITHUB_TOKEN`                         |
| `gitlab`    | GitLab project uploads                                   | Existing GitLab code-host settings     |
| `files-sdk` | Your Cloudflare R2 or AWS S3 bucket                      | [Storage settings](#files-sdk-uploader) |
| a module    | Anything                                                 | [Custom uploader](#custom-uploader)    |

Only artifacts selected as `embed` or `link` are uploaded. Uploaded URLs are reused on later publications to the same destination; changing the repository, instance, or storage target uploads again. Upload failures never block PR creation, and DevIntern never falls back to a different uploader or credential.

### Native GitHub and GitLab uploads

Use the code host itself when you don't want to set up storage:

```json
{
  "artifacts": {
    "publish": {
      "destination": "pr-comment",
      "uploader": "code-host",
      "select": [{ "key": "screenshot", "presentation": "embed" }]
    }
  }
}
```

The destination is the repository from the checkout's `origin` remote. Uploads use the same credentials DevIntern uses to open PRs and MRs: `GITHUB_TOKEN` for GitHub, and `GITLAB_CODE_HOST_TOKEN` for GitLab, which falls back to `GITLAB_TOKEN` only when `TASK_TRACKER=gitlab` and `GITLAB_BASE_URL` is the same instance (see [GitLab integration](./gitlab-integration.md)). Uploading doesn't create comments, commits, or branches.

**GitHub** uses the attachment endpoint the GitHub CLI uses for file attachments. GitHub doesn't document this endpoint as part of its public REST API, so it may change. If an upload fails, the comment says so and the PR is still created.

| Setting      | Supported                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Host         | github.com. GitHub Enterprise Server is not supported.                                                          |
| `GITHUB_TOKEN` | OAuth (`gho_`), classic (`ghp_`) and fine-grained (`github_pat_`) personal tokens, GitHub App user tokens (`ghu_`) |
| Not supported | GitHub App installation tokens (`ghs_`), including App-only setups without `GITHUB_TOKEN`. Use `files-sdk` or a custom uploader instead. |
| Permission   | Write access to the repository                                                                                 |
| Files        | PNG, GIF, JPEG, SVG, and MP4/MOV/WebM up to 10 MB; text, Markdown, CSV, JSON, logs/patches, PDF, ZIP, and gzip up to 25 MB |

Convert other formats, such as WebP, to PNG before you register them. Attachment URLs follow the repository's visibility: images from private repositories are visible only to people who can read the repository.

**GitLab** uploads files to the project with `POST /projects/:id/uploads`. It works on GitLab.com and on the Self-Managed instance set in `GITLAB_CODE_HOST_URL`, including installations under a path such as `https://git.example.com/gitlab`. It honors `GITLAB_CODE_HOST_CA_FILE` and `GITLAB_CODE_HOST_PROXY`. See [GitLab integration](./gitlab-integration.md#advanced-merge-requests-and-webhooks) for those settings. The size limit is the instance's maximum attachment size (100 MB by default).

Who can open an uploaded file depends on the project:

| Project                                                       | Uploaded files                                       |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| Public                                                        | Anyone can open them                                 |
| Private or internal (the default)                             | Anyone with the link can open them                   |
| Private or internal with **Require authentication to view media files** | Only signed-in users with project access can open them |

DevIntern never changes project visibility or media settings. The MR comment notes under each uploaded file who can open it, the run log warns when files from a private or internal project are viewable by anyone with the link, and run details in the dashboard show the same. To require sign-in, enable **Settings → General → Visibility, project features, permissions → Require authentication to view media files**.

If native uploads are unavailable, for example because of an unsupported token, read-only access, an unsupported file type, an oversized file, or an API error, the PR comment and the dashboard both show the reason. The run and the PR still succeed, and the local copy stays in the dashboard.

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

Workspace values apply to every repository; a repository's `env_file` or `[repos.env]` can override them. These values live in `~/.devintern`, outside your repositories.

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
