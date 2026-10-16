# pr-explainer-image

Generate a PNG explaining the final implementation and embed it in the managed
GitHub PR artifact comment. This is the image-generation counterpart to
`pr-explainer-visual`, which produces Markdown diagrams.

Run after commit, verification, and auto-review, immediately before `finalize`.
The step generates the image; `finalize` uploads and publishes the registered
artifact through the normal pipeline. Generation, capture, upload, and comment
failures remain advisory. No asset branch or extra repository commit is needed.

## Requirements

- A DevIntern build with `createFilesArtifactUploader` in its public pipeline API.
- An agent harness with an image-generation tool enabled and permission to save
  files. Text-only harnesses cannot run this step; the plugin warns and continues.
  DevIntern does not add image-generation tools to a harness automatically.
- An existing storage bucket and a durable public HTTP(S) URL serving its root.
  Configure bucket/CDN read access yourself; the uploader does not make a bucket
  public. The supplied adapter supports S3 and compatible services such as R2.
- Storage credentials in the worker's environment. Bun reads
  `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` or the corresponding AWS variables.

## Setup

```bash
mkdir -p .devintern-code/steps .devintern-code/prompts .devintern-code/adapters
cp examples/pipeline-plugins/pr-explainer-image/plugin.ts .devintern-code/steps/pr-explainer-image.ts
cp examples/pipeline-plugins/pr-explainer-image/prompts/image.md .devintern-code/prompts/pr-explainer-image.md
cp examples/pipeline-plugins/pr-explainer-image/artifact-storage.ts .devintern-code/adapters/artifact-storage.ts
cp examples/pipeline-plugins/pr-explainer-image/check-upload.ts .devintern-code/adapters/check-upload.ts
bun add -d @getdevintern/code
# The copied storage module imports Files SDK directly; declare it in your project too.
bun add files-sdk@3.1.1
```

Set the following in the worker environment, then merge `settings.json`'s
`pipeline` block into the repository's settings:

```dotenv
DEVINTERN_ARTIFACT_BUCKET=review-artifacts
DEVINTERN_ARTIFACT_REGION=us-east-1
DEVINTERN_ARTIFACT_PUBLIC_BASE_URL=https://artifacts.example.com/
DEVINTERN_ARTIFACT_KEY_PREFIX=devintern/artifacts
# For R2, also set region=auto and endpoint=https://<account-id>.r2.cloudflarestorage.com
# DEVINTERN_ARTIFACT_ENDPOINT=...
```

`artifact-storage.ts` default-exports an `ArtifactUploader`. It uses the public
`createFilesArtifactUploader({ files, publicBaseUrl, keyPrefix })` factory.
Swap `bunS3(...)` for another [Files SDK adapter](https://files-sdk.dev/docs/adapters)
to change providers. Keep the Files instance's own `prefix` empty; `keyPrefix`
is applied by the uploader and included in the returned URL. The base URL must
serve the same storage root, including any path prefix in that URL.

### Example: configure Cloudflare R2

1. Create a bucket such as `review-artifacts` in Cloudflare R2.
2. Create R2 S3 credentials with **Object Read & Write** permission scoped to
   this bucket. Save the Access Key ID and Secret Access Key in the worker's
   environment as `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. These are the
   S3 credentials, not the Cloudflare API bearer token.
3. In the bucket's **Settings → Custom Domains**, connect a domain such as
   `artifacts.example.com` and wait until it is active. Use a dedicated bucket:
   objects published through this domain are publicly readable, including PNGs
   that may contain implementation details. GitHub image embedding needs an
   anonymously fetchable URL; a login-protected domain cannot provide that.
4. Set the following in the worker environment:

   ```dotenv
   DEVINTERN_ARTIFACT_BUCKET=review-artifacts
   DEVINTERN_ARTIFACT_REGION=auto
   DEVINTERN_ARTIFACT_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   DEVINTERN_ARTIFACT_PUBLIC_BASE_URL=https://artifacts.example.com/
   DEVINTERN_ARTIFACT_KEY_PREFIX=devintern/artifacts
   S3_ACCESS_KEY_ID=<r2-access-key-id>
   S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
   ```

5. Check the target before enabling unattended publication:

   ```bash
   bun .devintern-code/adapters/check-upload.ts
   ```

   The probe writes one tiny `upload-check.txt` object and fetches its returned
   URL without credentials. It fails if the bytes cannot be read anonymously.
   If configuration lives in an environment file, load that same file when
   running the probe (for example `bun --env-file=/path/to/worker.env ...`).
   Restart the worker after changing its service environment.

The upload endpoint is the S3 API address. The public base URL is the custom
domain serving object bytes; they are different endpoints. Cloudflare's
`r2.dev` URL can be used for a development check, but it is rate-limited and
intended for non-production use. Keep published objects available for as long
as PR comments should work; avoid a lifecycle rule that expires them early.

See Cloudflare's [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/)
and [public bucket setup](https://developers.cloudflare.com/r2/buckets/public-buckets/).

### Other upload targets

For AWS S3, set the bucket and its AWS region, omit `DEVINTERN_ARTIFACT_ENDPOINT`,
and point the public base URL at a working object endpoint or CDN serving that
bucket. For other S3-compatible services, supply their endpoint and region.
Run the same upload probe to check credentials and the public URL mapping.
Non-S3 providers need a different Files SDK adapter in `artifact-storage.ts`;
the pipeline step and uploader factory stay the same.

The factory handles arbitrary artifact bytes, not just images. It preserves the
artifact MIME type, builds stable object keys from the bytes, MIME type, and
sanitized filename, and sets a 30-second deadline including retries. It returns
a durable URL under the configured base instead of an expiring signed URL.
The public URL is constructed, not probed; check your CDN mapping before live use.

## Output and failure walkthrough

The agent receives bounded task/diff blocks framed as untrusted input. It saves
`pr-explanation.png` in a fresh directory below `context.outputDir`, alongside
the exact `prompt.md`. The plugin checks the PNG signature and size (32 MiB
maximum), then snapshots it as `explanation-image`. Signature checks do not
prove that an image is decodable or factually correct; the prompt asks the agent
to inspect the rendered image against the diff. Review generated labels as usual.

The dashboard can preview the captured PNG. `finalize` uploads the latest selected
snapshot and embeds it in the managed **Artifacts & verification** comment.
Repeated publication reuses the recorded URL. Configure storage retention to
keep referenced objects available for the lifetime of the PR.

If the harness has no image tool, writes text instead of a PNG, or fails to
produce a file, the step warns and continues. A fresh output directory prevents
stale output from being mistaken for a new result. Upload failures leave the
local snapshot available and PR delivery continues.

## Files and validation

- `plugin.ts`, `prompts/image.md`, `settings.json`: generation and registration.
- `artifact-storage.ts`: copyable Files SDK storage configuration.
- `fixtures/`: a synthetic diff and tiny PNG encoded as base64.
- `tests/`: real step-runner, snapshot, stale-file, and advisory-failure checks.

```bash
bun run examples/pipeline-plugins/run-tests.ts pr-explainer-image
```

Tests inject image output and never call an image model or cloud storage. The
reusable uploader is tested separately in `packages/code/tests/files-sdk-uploader.test.ts`.
