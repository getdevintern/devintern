/**
 * Chat SDK state adapter with file-persisted thread subscriptions.
 *
 * The daemon is a single process, so in-memory locking/caching is correct;
 * only subscriptions must survive restarts (an unsubscribed thread's replies
 * would otherwise stop reaching the bot after a restart).
 */

import { dirname } from "node:path";
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { mkdir, pathExists, readFile, writeFile } from "../runtime/fs.js";

export class FilePersistedState extends MemoryStateAdapter {
  private readonly filePath: string;
  private readonly persistedSubscriptions = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  override async connect(): Promise<void> {
    await super.connect();
    if (await pathExists(this.filePath)) {
      try {
        const stored = JSON.parse(await readFile(this.filePath)) as string[];
        for (const threadId of stored) {
          await super.subscribe(threadId);
          this.persistedSubscriptions.add(threadId);
        }
      } catch {
        // Corrupt state file: start with no subscriptions rather than crash.
      }
    }
  }

  override async subscribe(threadId: string): Promise<void> {
    await super.subscribe(threadId);
    this.persistedSubscriptions.add(threadId);
    await this.persist();
  }

  override async unsubscribe(threadId: string): Promise<void> {
    await super.unsubscribe(threadId);
    this.persistedSubscriptions.delete(threadId);
    await this.persist();
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath));
      await writeFile(this.filePath, JSON.stringify([...this.persistedSubscriptions], null, 2));
    });
    return this.writeChain;
  }
}
