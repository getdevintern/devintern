import { Database } from "bun:sqlite";

import type { AutomationConfig } from "./automation-config";
import { prepareQueueDbDirectory } from "./webhook-queue";

export interface AutomationScheduleState {
  automationId: string;
  lastScheduledAt?: number;
  nextDueAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
}

/** Durable schedule cursors and overlap leases stored beside the worker queue. */
export class AutomationStateStore {
  private db: Database;

  constructor(dbPath: string) {
    prepareQueueDbDirectory(dbPath);
    this.db = new Database(dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS automation_schedules (
        automation_id TEXT PRIMARY KEY,
        schedule_spec TEXT NOT NULL,
        last_scheduled_at INTEGER,
        next_due_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        heartbeat_at INTEGER
      )
    `);
  }

  /** Create schedule state once; restarts retain the prior interval anchor. */
  register(automation: AutomationConfig, nextDueAt: number): void {
    const spec = automation.cron ? `cron:${automation.cron}` : `interval:${automation.interval}`;
    const existing = this.db
      .query("SELECT schedule_spec FROM automation_schedules WHERE automation_id = ?")
      .get(automation.id) as { schedule_spec: string } | null;
    if (!existing) {
      this.db.run(
        `INSERT INTO automation_schedules (automation_id, schedule_spec, next_due_at)
         VALUES (?, ?, ?)`,
        [automation.id, spec, nextDueAt],
      );
    } else if (existing.schedule_spec !== spec) {
      this.db.run(
        `UPDATE automation_schedules SET schedule_spec = ?, next_due_at = ?,
         last_scheduled_at = NULL WHERE automation_id = ?`,
        [spec, nextDueAt, automation.id],
      );
    }
  }

  get(automationId: string): AutomationScheduleState | null {
    const row = this.db
      .query("SELECT * FROM automation_schedules WHERE automation_id = ?")
      .get(automationId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      automationId: row.automation_id as string,
      lastScheduledAt: (row.last_scheduled_at as number | null) ?? undefined,
      nextDueAt: row.next_due_at as number,
      leaseOwner: (row.lease_owner as string | null) ?? undefined,
      leaseExpiresAt: (row.lease_expires_at as number | null) ?? undefined,
      heartbeatAt: (row.heartbeat_at as number | null) ?? undefined,
    };
  }

  /** Atomically claim one due occurrence and advance its cursor before execution. */
  claim(
    automationId: string,
    owner: string,
    now: number,
    nextDueAt: number,
    leaseMs: number,
  ): boolean {
    const result = this.db.run(
      `UPDATE automation_schedules
       SET last_scheduled_at = next_due_at, next_due_at = ?, lease_owner = ?,
           lease_expires_at = ?, heartbeat_at = ?
       WHERE automation_id = ? AND next_due_at <= ?
         AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      [nextDueAt, owner, now + leaseMs, now, automationId, now, now],
    );
    return result.changes === 1;
  }

  /** Coalesce a due occurrence skipped because the previous run is still active. */
  skipOverlap(automationId: string, now: number, nextDueAt: number): boolean {
    const result = this.db.run(
      `UPDATE automation_schedules SET last_scheduled_at = next_due_at, next_due_at = ?
       WHERE automation_id = ? AND next_due_at <= ?
         AND lease_owner IS NOT NULL AND lease_expires_at > ?`,
      [nextDueAt, automationId, now, now],
    );
    return result.changes === 1;
  }

  heartbeat(automationId: string, owner: string, now: number, leaseMs: number): boolean {
    const result = this.db.run(
      `UPDATE automation_schedules SET heartbeat_at = ?, lease_expires_at = ?
       WHERE automation_id = ? AND lease_owner = ?`,
      [now, now + leaseMs, automationId, owner],
    );
    return result.changes === 1;
  }

  release(automationId: string, owner: string): void {
    this.db.run(
      `UPDATE automation_schedules SET lease_owner = NULL, lease_expires_at = NULL,
       heartbeat_at = NULL WHERE automation_id = ? AND lease_owner = ?`,
      [automationId, owner],
    );
  }

  close(): void {
    this.db.close();
  }
}
