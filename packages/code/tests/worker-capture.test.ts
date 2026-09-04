import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { parseTimestampPrefix } from "../src/lib/worker-logs";
import { startWorkerCapture, WORKER_CAPTURE_ROTATE_BYTES } from "../src/lib/worker-capture";

describe("startWorkerCapture", () => {
  let tempDir: string;
  const savedConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  const makeTempDir = (): string => {
    const dir = join(
      "/tmp",
      `devintern-worker-capture-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  afterAll(() => {
    Object.assign(console, savedConsole);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    Object.assign(console, savedConsole);
  });

  test("tees console output into the capture files", () => {
    tempDir = makeTempDir();
    const capture = startWorkerCapture(tempDir);
    try {
      console.log("hello out");
      console.info("info out");
      console.error("hello err");
      console.warn("warn err");
      const out = readFileSync(join(tempDir, "worker.stdout.log"), "utf8");
      const err = readFileSync(join(tempDir, "worker.stderr.log"), "utf8");
      expect(out).toContain("hello out");
      expect(out).toContain("info out");
      expect(err).toContain("hello err");
      expect(err).toContain("warn err");
      expect(out).not.toContain("hello err");
    } finally {
      capture.stop();
    }
  });

  test("prefixes timestamped lines the dashboard can parse and order", () => {
    tempDir = makeTempDir();
    const capture = startWorkerCapture(tempDir);
    try {
      console.log("with timestamp");
      const first = readFileSync(join(tempDir, "worker.stdout.log"), "utf8").trimEnd();
      for (const line of first.split("\n")) {
        expect(parseTimestampPrefix(line)).not.toBeNull();
      }
      console.log("second line");
      const second = readFileSync(join(tempDir, "worker.stdout.log"), "utf8").trimEnd();
      const a = parseTimestampPrefix(first.split("\n").at(-1)!)!.timestampMs;
      const b = parseTimestampPrefix(second.split("\n").at(-1)!)!.timestampMs;
      expect(a <= b).toBe(true);
    } finally {
      capture.stop();
    }
  });

  test("formats multiple arguments like console does", () => {
    tempDir = makeTempDir();
    const capture = startWorkerCapture(tempDir);
    try {
      console.log("key:", 42, { a: 1 });
      const out = readFileSync(join(tempDir, "worker.stdout.log"), "utf8");
      expect(out).toContain("key: 42 { a: 1 }");
    } finally {
      capture.stop();
    }
  });

  test("stop() restores the original console and closes the files", () => {
    tempDir = makeTempDir();
    const originalLog = console.log;
    const capture = startWorkerCapture(tempDir);
    expect(console.log).not.toBe(originalLog);
    capture.stop();
    expect(console.log).toBe(originalLog);

    // Writes after stop() must not land anywhere.
    const before = statSync(join(tempDir, "worker.stdout.log")).size;
    savedConsole.log("not captured");
    expect(statSync(join(tempDir, "worker.stdout.log")).size).toBe(before);
  });

  test("rotates oversized files to <name>.1 on start", () => {
    tempDir = makeTempDir();
    writeFileSync(join(tempDir, "worker.stdout.log"), "x".repeat(WORKER_CAPTURE_ROTATE_BYTES + 1));
    const capture = startWorkerCapture(tempDir);
    try {
      expect(statSync(join(tempDir, "worker.stdout.log.1")).size).toBe(
        WORKER_CAPTURE_ROTATE_BYTES + 1,
      );
      console.log("fresh");
      const out = readFileSync(join(tempDir, "worker.stdout.log"), "utf8");
      expect(out).toContain("fresh");
      expect(out).not.toContain("xxxxxxxx");
    } finally {
      capture.stop();
    }
  });
});
