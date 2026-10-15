import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, join, resolve, sep } from "path";
import { configureSqliteConnection } from "../state/sqlite";
import { prepareQueueDbDirectory, resolveQueueDbPath } from "../state/webhook-queue";
import { resolveWorkspaceDir } from "../workspace/paths";
import { redactSecrets, stripAnsi } from "../observability/worker-logs";
import type { ArtifactInput, ArtifactPublication, RunArtifact } from "./types";

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_TEXT_BYTES = 512 * 1024;
const MAX_ARTIFACTS_PER_RUN = 200;

/** Text content is sanitized before persistence, dashboard rendering, or publication. */
export function isTextArtifact(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") || ["application/json", "application/xml"].includes(mediaType)
  );
}

/** SQLite metadata survives missing/expired files; each blob is an immutable snapshot. */
export class ArtifactStore {
  private db: Database;
  readonly root: string;

  constructor(
    readonly dbPath = resolveQueueDbPath(),
    options: { readonly?: boolean; root?: string } = {},
  ) {
    if (!options.readonly) prepareQueueDbDirectory(dbPath);
    this.db = options.readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
    configureSqliteConnection(this.db, { readonly: options.readonly });
    this.root =
      options.root ??
      join(
        resolveWorkspaceDir(),
        "artifacts",
        createHash("sha256").update(resolve(dbPath)).digest("hex").slice(0, 16),
      );
    if (!options.readonly)
      this.db.exec(`CREATE TABLE IF NOT EXISTS run_artifacts (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, run_id INTEGER, metadata TEXT NOT NULL,
      publication TEXT
    ); CREATE INDEX IF NOT EXISTS run_artifacts_run ON run_artifacts(run_id);
    CREATE TABLE IF NOT EXISTS run_artifact_uploads (
      artifact_id TEXT NOT NULL, uploader TEXT NOT NULL, url TEXT, error TEXT,
      PRIMARY KEY (artifact_id, uploader)
    )`);
  }

  add(
    input: ArtifactInput,
    owner: {
      scope: string;
      runId: number | null;
      step: string;
      iteration: number;
      commitSha?: string;
    },
    allowedRoots: string[],
  ): RunArtifact {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.key))
      throw new Error("Artifact key must be a simple identifier (1–128 characters)");
    if (!input.title?.trim() || input.title.length > 200)
      throw new Error("Artifact title must have 1–200 characters");
    if (!["explanation", "verification", "image", "report", "debug"].includes(input.kind))
      throw new Error("Unknown artifact kind");
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(input.mediaType))
      throw new Error("Invalid artifact media type");
    const count = this.db
      .query("SELECT count(*) AS n FROM run_artifacts WHERE scope = ?")
      .get(owner.scope) as { n: number };
    if (count.n >= MAX_ARTIFACTS_PER_RUN) throw new Error("Run artifact count limit reached");
    const source = realpathSync(input.path);
    if (
      !allowedRoots.some((root) => {
        const realRoot = realpathSync(root);
        return source.startsWith(realRoot + sep);
      })
    )
      throw new Error("Artifact source is outside the working/output directories");
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
        throw new Error("Artifact must be a regular file of at most 32 MiB");
      bytes = Buffer.alloc(stat.size);
      let filled = 0;
      while (filled < bytes.length) {
        const n = readSync(fd, bytes, filled, bytes.length - filled, filled);
        if (!n) break;
        filled += n;
      }
      bytes = bytes.subarray(0, filled);
    } finally {
      closeSync(fd);
    }
    if (isTextArtifact(input.mediaType))
      bytes = Buffer.from(redactSecrets(stripAnsi(bytes.toString("utf8"))));
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("Sanitized artifact exceeds 32 MiB");
    const id = randomUUID();
    const artifact: RunArtifact = {
      id,
      runId: owner.runId,
      step: owner.step,
      iteration: owner.iteration,
      commitSha: owner.commitSha,
      key: input.key,
      title: redactSecrets(stripAnsi(input.title)).replace(/\s+/g, " ").trim(),
      kind: input.kind,
      mediaType: input.mediaType,
      name: basename(source),
      size: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      createdAt: Date.now(),
      available: true,
    };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, id);
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    try {
      this.db.run("INSERT INTO run_artifacts(id, scope, run_id, metadata) VALUES (?, ?, ?, ?)", [
        id,
        owner.scope,
        owner.runId,
        JSON.stringify(artifact),
      ]);
    } catch (error) {
      unlinkSync(target);
      throw error;
    }
    return artifact;
  }

  list(runId: number | null, scope?: string): RunArtifact[] {
    const rows = scope
      ? this.db
          .query("SELECT metadata, publication FROM run_artifacts WHERE scope = ? ORDER BY rowid")
          .all(scope)
      : this.db
          .query("SELECT metadata, publication FROM run_artifacts WHERE run_id = ? ORDER BY rowid")
          .all(runId);
    return (rows as { metadata: string; publication: string | null }[]).map(
      ({ metadata, publication }) => {
        const artifact = JSON.parse(metadata) as RunArtifact;
        const upload = this.db
          .query(
            "SELECT url, error FROM run_artifact_uploads WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(artifact.id) as { url: string | null; error: string | null } | null;
        return {
          ...artifact,
          publication: publication ? (JSON.parse(publication) as ArtifactPublication) : undefined,
          upload: upload
            ? {
                status: upload.url ? ("uploaded" as const) : ("failed" as const),
                url: upload.url ?? undefined,
                message: upload.error ?? undefined,
              }
            : undefined,
          available: existsSync(join(this.root, artifact.id)),
        };
      },
    );
  }

  read(artifact: RunArtifact): Buffer | null {
    if (!/^[a-f0-9-]{36}$/.test(artifact.id)) return null;
    try {
      const fd = openSync(join(this.root, artifact.id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_ARTIFACT_BYTES) return null;
        const bytes = readFileSync(fd);
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.checksum) return null;
        return bytes;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  recordPublication(ids: string[], publication: ArtifactPublication): void {
    const write = this.db.transaction(() => {
      for (const id of ids)
        this.db.run("UPDATE run_artifacts SET publication = ? WHERE id = ?", [
          JSON.stringify({
            ...publication,
            message: publication.message ? redactSecrets(publication.message) : undefined,
          }),
          id,
        ]);
    });
    write();
  }

  getUpload(id: string, uploader: string): string | undefined {
    const row = this.db
      .query("SELECT url FROM run_artifact_uploads WHERE artifact_id = ? AND uploader = ?")
      .get(id, uploader) as { url: string | null } | null;
    return row?.url ?? undefined;
  }

  recordUpload(id: string, uploader: string, result: { url?: string; error?: string }): void {
    this.db.run(
      "INSERT OR REPLACE INTO run_artifact_uploads(artifact_id, uploader, url, error) VALUES (?, ?, ?, ?)",
      [id, uploader, result.url ?? null, result.error ? redactSecrets(result.error) : null],
    );
  }

  close(): void {
    this.db.close();
  }
}
