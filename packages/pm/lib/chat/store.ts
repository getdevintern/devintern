/**
 * Session persistence for the chat bot daemon.
 *
 * Sessions are a small map (one per active conversation thread), so a
 * write-through JSON file is sufficient and keeps the published CLI free of
 * native/runtime-specific storage. The interface leaves room to swap in
 * sqlite if session volume ever demands it.
 */

import { dirname } from "node:path";
import { mkdir, pathExists, readFile, writeFile } from "../runtime/fs.js";
import { isExpired } from "./session.js";
import type { DraftSession } from "./session.js";

export interface SessionStore {
  get(key: string): DraftSession | undefined;
  upsert(session: DraftSession): Promise<void>;
  delete(key: string): Promise<void>;
  all(): DraftSession[];
  /** Remove sessions idle past `ttlMs`; returns the removed sessions. */
  sweepExpired(now: number, ttlMs: number): Promise<DraftSession[]>;
  close(): Promise<void>;
}

interface StoreFileShape {
  version: 1;
  sessions: DraftSession[];
}

/**
 * Create a store backed by a JSON file, loading existing sessions eagerly.
 *
 * Interrupted `generating`/`creating` sessions are rewritten to `failed` on
 * load: the in-flight engine call died with the previous process.
 *
 * @param filePath - JSON file location, e.g. `.devintern-pm/chat-sessions.json`.
 */
export async function createFileSessionStore(filePath: string): Promise<SessionStore> {
  const sessions = new Map<string, DraftSession>();

  if (await pathExists(filePath)) {
    try {
      const parsed = JSON.parse(await readFile(filePath)) as StoreFileShape;
      for (const session of parsed.sessions ?? []) {
        if (session.status === "generating" || session.status === "creating") {
          session.status = "failed";
        }
        sessions.set(session.key, session);
      }
    } catch {
      // Corrupt store file: start fresh rather than crash the daemon.
    }
  }

  // Serialize writes so concurrent upserts can't interleave partial files.
  let writeChain: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    writeChain = writeChain.then(async () => {
      const payload: StoreFileShape = { version: 1, sessions: [...sessions.values()] };
      await mkdir(dirname(filePath));
      await writeFile(filePath, JSON.stringify(payload, null, 2));
    });
    return writeChain;
  }

  return {
    get: (key) => sessions.get(key),
    all: () => [...sessions.values()],
    async upsert(session) {
      sessions.set(session.key, session);
      await persist();
    },
    async delete(key) {
      if (sessions.delete(key)) await persist();
    },
    async sweepExpired(now, ttlMs) {
      const removed: DraftSession[] = [];
      for (const session of sessions.values()) {
        if (isExpired(session, now, ttlMs)) {
          sessions.delete(session.key);
          removed.push(session);
        }
      }
      if (removed.length > 0) await persist();
      return removed;
    },
    async close() {
      await writeChain;
    },
  };
}

/** In-memory store for tests. */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, DraftSession>();
  return {
    get: (key) => sessions.get(key),
    all: () => [...sessions.values()],
    async upsert(session) {
      sessions.set(session.key, session);
    },
    async delete(key) {
      sessions.delete(key);
    },
    async sweepExpired(now, ttlMs) {
      const removed: DraftSession[] = [];
      for (const session of sessions.values()) {
        if (isExpired(session, now, ttlMs)) {
          sessions.delete(session.key);
          removed.push(session);
        }
      }
      return removed;
    },
    async close() {},
  };
}
