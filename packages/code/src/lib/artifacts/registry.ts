import { resolve } from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import { getActiveRunContext } from "../state/run-recorder";
import { ArtifactStore, isTextArtifact, MAX_ARTIFACT_TEXT_BYTES } from "./store";
import type { ArtifactInput, ArtifactRegistry, RunArtifact } from "./types";

/** Execution-local facade; each registration is persisted immediately, even if the step later fails. */
export class RunArtifactRegistry implements ArtifactRegistry {
  private scope: string;
  private runId: number | null;
  private step = "pipeline";
  private iteration = 1;
  private commitSha?: string;

  constructor(
    private workingDir: string,
    private outputDir: string,
    private dbPath?: string,
  ) {
    this.runId = getActiveRunContext()?.id ?? null;
    this.scope = this.runId === null ? randomUUID() : `run-${this.runId}`;
  }

  beginStep(step: string, iteration: number): void {
    this.step = step;
    this.iteration = iteration;
  }

  async addFile(input: ArtifactInput): Promise<RunArtifact | null> {
    let store: ArtifactStore | undefined;
    try {
      this.commitSha =
        spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: this.workingDir,
          encoding: "utf8",
        }).stdout?.trim() || undefined;
      store = new ArtifactStore(this.dbPath);
      return store.add(
        { ...input, path: resolve(this.workingDir, input.path) },
        {
          scope: this.scope,
          runId: this.runId,
          step: this.step,
          iteration: this.iteration,
          commitSha: this.commitSha,
        },
        [this.workingDir, this.outputDir],
      );
    } catch (error) {
      console.warn(`⚠️ Artifact capture failed (${input.key}): ${(error as Error).message}`);
      return null;
    } finally {
      store?.close();
    }
  }

  list(): RunArtifact[] {
    let store: ArtifactStore | undefined;
    try {
      store = new ArtifactStore(this.dbPath, { readonly: true });
      return store.list(this.runId, this.scope);
    } catch {
      return [];
    } finally {
      store?.close();
    }
  }

  recordPublication(ids: string[], publication: import("./types").ArtifactPublication): void {
    let store: ArtifactStore | undefined;
    try {
      store = new ArtifactStore(this.dbPath);
      store.recordPublication(ids, publication);
    } catch (error) {
      console.warn(`⚠️ Artifact publication recording failed: ${(error as Error).message}`);
    } finally {
      store?.close();
    }
  }

  readText(id: string): string | null {
    const artifact = this.list().find((entry) => entry.id === id);
    if (!artifact || !isTextArtifact(artifact.mediaType) || artifact.size > MAX_ARTIFACT_TEXT_BYTES)
      return null;
    let store: ArtifactStore | undefined;
    try {
      store = new ArtifactStore(this.dbPath, { readonly: true });
      return store.read(artifact)?.toString("utf8") ?? null;
    } catch {
      return null;
    } finally {
      store?.close();
    }
  }

  readBytes(id: string): Uint8Array | null {
    const artifact = this.list().find((entry) => entry.id === id);
    if (!artifact) return null;
    let store: ArtifactStore | undefined;
    try {
      store = new ArtifactStore(this.dbPath, { readonly: true });
      return store.read(artifact);
    } catch {
      return null;
    } finally {
      store?.close();
    }
  }

  uploadUrl(id: string, uploader: string): string | undefined {
    let store: ArtifactStore | undefined;
    try {
      store = new ArtifactStore(this.dbPath, { readonly: true });
      return store.getUpload(id, uploader);
    } catch {
      return undefined;
    } finally {
      store?.close();
    }
  }

  recordUpload(id: string, uploader: string, result: { url?: string; error?: string }): void {
    let store: ArtifactStore | undefined;
    try {
      store = new ArtifactStore(this.dbPath);
      store.recordUpload(id, uploader, result);
    } catch (error) {
      console.warn(`⚠️ Artifact upload recording failed: ${(error as Error).message}`);
    } finally {
      store?.close();
    }
  }
}
