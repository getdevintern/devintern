import { loadFilesArtifactUploader } from "@getdevintern/code/pipeline";

// Used by check-upload.ts. The pipeline selects the same built-in via "files-sdk".
const uploader = loadFilesArtifactUploader().adapter;

export default uploader;
