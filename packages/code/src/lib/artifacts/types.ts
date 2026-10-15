/** A file deliberately exposed by a pipeline step. Paths are never used as artifact identities. */
export interface ArtifactInput {
  key: string;
  path: string;
  title: string;
  kind: "explanation" | "verification" | "image" | "report" | "debug";
  mediaType: string;
}

/** Immutable snapshot of one output from one execution of a step. */
export interface RunArtifact extends Omit<ArtifactInput, "path"> {
  id: string;
  runId: number | null;
  step: string;
  iteration: number;
  commitSha?: string;
  name: string;
  size: number;
  checksum: string;
  createdAt: number;
  available: boolean;
  publication?: ArtifactPublication;
  upload?: { status: "uploaded" | "failed"; url?: string; message?: string };
}

/** Pipeline-facing API. Registration is advisory and returns null on capture failure. */
export interface ArtifactRegistry {
  addFile(input: ArtifactInput): Promise<RunArtifact | null>;
  list(): RunArtifact[];
  readText(id: string): string | null;
  readBytes(id: string): Uint8Array | null;
}

export interface ArtifactSelection {
  key: string;
  presentation: "inline" | "collapsed" | "embed" | "link";
}

export interface ArtifactPolicy {
  publish?: {
    destination: "pr-comment";
    select: ArtifactSelection[];
    /** Plugin module default-exporting ArtifactUploader. Relative to the pipeline file. */
    uploader?: string;
  };
}

/** Upload adapters own access control and URL lifetime; registration never uploads files. */
export interface ArtifactUploader {
  upload(artifact: RunArtifact, bytes: Uint8Array): Promise<{ url: string }>;
}

export interface ArtifactPublication {
  status: "published" | "failed" | "skipped";
  commentId?: number;
  commentUrl?: string;
  message?: string;
}
