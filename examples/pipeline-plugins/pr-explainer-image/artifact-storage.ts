import { Files } from "files-sdk";
import { bunS3 } from "files-sdk/bun-s3";
import { createFilesArtifactUploader } from "@getdevintern/code/pipeline";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before loading the artifact uploader`);
  return value;
}

const uploader = createFilesArtifactUploader({
  files: new Files({
    adapter: bunS3({
      bucket: required("DEVINTERN_ARTIFACT_BUCKET"),
      region: process.env.DEVINTERN_ARTIFACT_REGION ?? "us-east-1",
      endpoint: process.env.DEVINTERN_ARTIFACT_ENDPOINT,
    }),
  }),
  publicBaseUrl: required("DEVINTERN_ARTIFACT_PUBLIC_BASE_URL"),
  keyPrefix: process.env.DEVINTERN_ARTIFACT_KEY_PREFIX ?? "devintern/artifacts",
});

export default uploader;
