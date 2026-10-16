import { createHash } from "node:crypto";
import uploader from "./artifact-storage";

// Run manually after configuring storage. This writes one small, persistent probe.
const bytes = new TextEncoder().encode("DevIntern artifact upload check\n");
const { url } = await uploader.upload(
  {
    id: "upload-check",
    key: "upload-check",
    runId: null,
    step: "manual-upload-check",
    iteration: 1,
    name: "upload-check.txt",
    title: "Upload target check",
    kind: "debug",
    mediaType: "text/plain",
    size: bytes.byteLength,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    createdAt: Date.now(),
    available: true,
  },
  bytes,
);
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!response.ok || (await response.text()) !== new TextDecoder().decode(bytes)) {
  throw new Error(`Upload succeeded but anonymous read failed at ${url} (HTTP ${response.status})`);
}
console.log(`Upload and anonymous read succeeded: ${url}`);
