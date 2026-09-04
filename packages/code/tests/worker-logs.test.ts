import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  classifyLevel,
  extractTaskKey,
  parseTimestampPrefix,
  readWorkerLogs,
  redactSecrets,
  stripAnsi,
} from "../src/lib/worker-logs";

describe("worker log parsing", () => {
  test("stripAnsi removes color/cursor codes and carriage returns", () => {
    expect(stripAnsi("\x1b[31m❌ Failed\x1b[0m\r\nnext")).toBe("❌ Failed\nnext");
    // Bracketed text without a real escape prefix must survive.
    expect(stripAnsi("[plain] [0m [info]")).toBe("[plain] [0m [info]");
  });

  test("parseTimestampPrefix reads ISO prefixes and rejects bare dates/none", () => {
    const zulu = parseTimestampPrefix("2026-08-27T12:34:56.789Z hello world");
    expect(zulu?.timestampMs).toBe(Date.parse("2026-08-27T12:34:56.789Z"));
    expect(zulu?.rest).toBe("hello world");

    const offset = parseTimestampPrefix("2026-08-27 12:34:56 +0200 boot");
    expect(offset?.rest).toBe("boot");
    expect(offset?.timestampMs).toBe(Date.parse("2026-08-27T12:34:56+02:00"));

    // Bare dates are not trusted as timestamps.
    expect(parseTimestampPrefix("2026-08-27 something happened")).toBeNull();
    expect(parseTimestampPrefix("plain line")).toBeNull();
  });

  test("classifyLevel prefers explicit markers over the stream default", () => {
    expect(classifyLevel("out", "❌ boom")).toBe("error");
    expect(classifyLevel("err", "⚠️  careful")).toBe("warn");
    expect(classifyLevel("out", "ALL CAPS ERROR TEXT")).toBe("error");
    expect(classifyLevel("err", "console.error output")).toBe("error");
    expect(classifyLevel("out", "polling jira")).toBe("info");
  });

  test("extractTaskKey skips stop-listed prefixes", () => {
    expect(extractTaskKey("processed SHA-256 then DEV-99 ok")).toBe("DEV-99");
    expect(extractTaskKey("CVE-2024-1234 alone")).toBeNull();
    expect(extractTaskKey("nothing to see")).toBeNull();
  });

  test("redactSecrets masks credential assignments and token shapes", () => {
    expect(redactSecrets("starting with GITHUB_TOKEN=ghp_abcdef0123456789 done")).toBe(
      "starting with GITHUB_TOKEN=[redacted] done",
    );
    expect(redactSecrets("raw github ghp_abcdef0123456789012 stays masked")).toBe(
      "raw github [redacted] stays masked",
    );
    expect(redactSecrets("Bearer eyJhbGciOiJIUzI1Ni.x.y")).toBe("Bearer [redacted]");
    // Unrelated assignments survive untouched.
    expect(redactSecrets("WORKER_POLL_INTERVAL=30")).toBe("WORKER_POLL_INTERVAL=30");
  });
});

describe("worker log tailing", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `wlogs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing capture files degrade to an empty, unavailable result", () => {
    const result = readWorkerLogs({ dirs: [dir], limit: 10 });
    expect(result.available).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.sources.every((source) => !source.exists)).toBe(true);
  });

  test("reads both streams, strips ANSI, classifies levels, redacts secrets", () => {
    writeFileSync(
      join(dir, "worker.stdout.log"),
      "✅ Connected\n\x1b[36mDEV-1 started\x1b[0m\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "worker.stderr.log"),
      "review failed GITHUB_TOKEN=ghp_secretsecretsecret123\n",
      "utf8",
    );

    const result = readWorkerLogs({ dirs: [dir], limit: 100 });
    expect(result.available).toBe(true);

    const messages = result.entries.map((entry) => entry.message);
    expect(messages).toContain("✅ Connected");
    expect(messages).toContain("DEV-1 started");
    expect(messages.some((message) => message.includes("ghp_"))).toBe(false);
    expect(messages.some((message) => message.includes("[redacted]"))).toBe(true);

    expect(result.entries.find((entry) => entry.message === "DEV-1 started")?.level).toBe("info");
    expect(
      result.entries.find((entry) => entry.stream === "err" && entry.level === "error"),
    ).toBeDefined();

    const keyEntry = result.entries.find((entry) => entry.taskKey !== null);
    expect(keyEntry?.taskKey).toBe("DEV-1");
  });

  test("reads are bounded by a byte window and flagged truncated", () => {
    const padded = Array.from({ length: 40 }, (_, i) => `${"y".repeat(72)} row-${i}`)
      .join("\n")
      .concat("\n");
    writeFileSync(join(dir, "worker.stdout.log"), `${padded}tail marker\n`, "utf8");

    const result = readWorkerLogs({ dirs: [dir], limit: 500, maxBytesPerFile: 256 });
    expect(result.truncated).toBe(true);

    const stdoutSource = result.sources.find((source) => source.stream === "out");
    expect(stdoutSource?.readBytes ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(257);
    expect(result.entries.length).toBeLessThan(5);
    expect(result.entries.at(-1)?.message).toBe("tail marker");
  });

  test("limit keeps only the newest entries while marking truncation", () => {
    writeFileSync(join(dir, "worker.stdout.log"), "first\nsecond\nthird\n", "utf8");
    const result = readWorkerLogs({ dirs: [dir], limit: 2 });
    expect(result.entries.map((entry) => entry.message)).toEqual(["second", "third"]);
    expect(result.entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(result.truncated).toBe(true);
  });

  test("level filter narrows the returned window server-side", () => {
    writeFileSync(
      join(dir, "worker.stdout.log"),
      "ok line\n⚠️  warn one\nregular\n❌ fatal one\n⚠️  warn two\n",
      "utf8",
    );
    const errors = readWorkerLogs({ dirs: [dir], limit: 100, level: "error" });
    expect(errors.entries.map((entry) => entry.message)).toEqual(["❌ fatal one"]);
    const warns = readWorkerLogs({ dirs: [dir], limit: 100, level: "warn" });
    expect(warns.entries.map((entry) => entry.message)).toEqual(["⚠️  warn one", "⚠️  warn two"]);
    const all = readWorkerLogs({ dirs: [dir], limit: 100 });
    expect(all.entries.length).toBe(5);
  });

  test("interleaves streams round-robin when timestamps are absent", () => {
    writeFileSync(join(dir, "worker.stdout.log"), "out a\nout b\n", "utf8");
    writeFileSync(join(dir, "worker.stderr.log"), "err a\nerr b\n", "utf8");
    const result = readWorkerLogs({ dirs: [dir], limit: 100 });
    expect(result.entries.map((entry) => entry.message)).toEqual([
      "out a",
      "err a",
      "out b",
      "err b",
    ]);
  });

  test("sorts truly by timestamp when every line carries one", () => {
    writeFileSync(
      join(dir, "worker.stdout.log"),
      "2026-01-01T00:00:01Z out later\n2026-01-01T00:00:03Z out latest\n",
      "utf8",
    );
    writeFileSync(join(dir, "worker.stderr.log"), "2026-01-01T00:00:02Z err between\n", "utf8");
    const result = readWorkerLogs({ dirs: [dir], limit: 100 });
    expect(result.entries.map((entry) => entry.timestamp)).toEqual([
      Date.parse("2026-01-01T00:00:01Z"),
      Date.parse("2026-01-01T00:00:02Z"),
      Date.parse("2026-01-01T00:00:03Z"),
    ]);
  });

  test("appends are picked up on the next read (tailing)", () => {
    const path = join(dir, "worker.stdout.log");
    writeFileSync(path, "before append\n", "utf8");
    expect(readWorkerLogs({ dirs: [dir] }).entries.map((entry) => entry.message)).toEqual([
      "before append",
    ]);
    appendFileSync(path, "after append\n", "utf8");
    expect(readWorkerLogs({ dirs: [dir] }).entries.map((entry) => entry.message)).toEqual([
      "before append",
      "after append",
    ]);
  });

  test("deduplicates capture files shared by primary and fallback dirs", () => {
    writeFileSync(join(dir, "worker.stdout.log"), "shared line\n", "utf8");
    const result = readWorkerLogs({ dirs: [dir, dir], limit: 100 });
    expect(result.entries.length).toBe(1);
    expect(result.sources.length).toBe(2);
  });

  test("unreadable sources report the error without failing the read", () => {
    // A directory standing in for the capture file fails on read everywhere
    // (EISDIR locally, or on macOS at open), exercising the guarded path.
    mkdirSync(join(dir, "worker.stderr.log"));
    writeFileSync(join(dir, "worker.stdout.log"), "fine\n", "utf8");

    const result = readWorkerLogs({ dirs: [dir], limit: 100 });
    expect(result.available).toBe(true);
    expect(result.entries.map((entry) => entry.message)).toEqual(["fine"]);
    const broken = result.sources.find((source) => source.stream === "err");
    expect(broken?.exists).toBe(true);
    expect(broken?.error).not.toBe("");
  });
});
