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
  upload?: {
    status: "uploaded" | "failed";
    url?: string;
    message?: string;
    /** Provider identifier retained for future cleanup (for example a GitLab upload ID). */
    remoteId?: string;
    /** Effective access behavior reported by the destination, when discoverable. */
    notice?: string;
  };
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
  /** Omit the section entirely when no artifact with this key was captured (instead of "Not captured."). */
  optional?: boolean;
}

export interface ArtifactPolicy {
  publish?: {
    destination: "pr-comment";
    select: ArtifactSelection[];
    /**
     * Built-in "files-sdk", "github", "gitlab", or "code-host" (the native adapter
     * for the origin remote), or a module default-exporting ArtifactUploader.
     */
    uploader?: string;
  };
}

/** Upload adapters own access control and URL lifetime; registration never uploads files. */
export interface ArtifactUploader {
  upload(artifact: RunArtifact, bytes: Uint8Array): Promise<ArtifactUploadResult>;
}

export interface ArtifactUploadResult {
  /** Durable HTTP(S) URL reviewers can open. */
  url: string;
  /** Destination-side identifier for future cleanup, when the provider returns one. */
  remoteId?: string;
  /** Effective visibility/access behavior to surface to operators. */
  notice?: string;
  /**
   * True when anyone holding the URL can open the file even though the source
   * project is not public (for example GitLab media without enforced auth).
   */
  linkPublic?: boolean;
}

export interface ArtifactPublication {
  status: "published" | "failed" | "skipped";
  commentId?: number;
  commentUrl?: string;
  message?: string;
}
