import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm as nodeRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { readFile, writeFile, pathExists, pathExistsSync, mkdir, rm } from "./fs.js";
import { getModuleDir } from "./path.js";
import { getArgs } from "./args.js";
import { askConfirm } from "./stdin.js";
import {
  configureTerminalEncoding,
  hasUtf8Locale,
  resetTerminalDetectionForTests,
  uiSymbols,
} from "./terminal.js";

describe("runtime/fs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-runtime-test-"));
  });

  afterEach(async () => {
    await nodeRm(tempDir, { recursive: true, force: true });
  });

  test("writeFile creates nested directories and writes content", async () => {
    const filePath = join(tempDir, "a", "b", "c", "test.txt");
    await writeFile(filePath, "hello world");
    const content = await readFile(filePath);
    expect(content).toBe("hello world");
  });

  test("writeFile works with a single-level path", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "single level");
    const content = await readFile(filePath);
    expect(content).toBe("single level");
  });

  test("pathExists returns true for existing file", async () => {
    const filePath = join(tempDir, "exists.txt");
    await writeFile(filePath, "yes");
    expect(await pathExists(filePath)).toBe(true);
  });

  test("pathExists returns false for missing path", async () => {
    const missingPath = join(tempDir, "does-not-exist.txt");
    expect(await pathExists(missingPath)).toBe(false);
  });

  test("pathExistsSync returns true for existing file", async () => {
    const filePath = join(tempDir, "sync-exists.txt");
    await writeFile(filePath, "yes");
    expect(pathExistsSync(filePath)).toBe(true);
  });

  test("pathExistsSync returns false for missing path", () => {
    const missingPath = join(tempDir, "sync-missing.txt");
    expect(pathExistsSync(missingPath)).toBe(false);
  });

  test("mkdir creates intermediate directories", async () => {
    const dirPath = join(tempDir, "x", "y", "z");
    await mkdir(dirPath);
    expect(await pathExists(dirPath)).toBe(true);
  });

  test("rm removes file recursively", async () => {
    const filePath = join(tempDir, "to-delete.txt");
    await writeFile(filePath, "bye");
    expect(await pathExists(filePath)).toBe(true);
    await rm(filePath);
    expect(await pathExists(filePath)).toBe(false);
  });

  test("rm removes directory recursively", async () => {
    const dirPath = join(tempDir, "nested", "dir");
    await mkdir(dirPath);
    const filePath = join(dirPath, "file.txt");
    await writeFile(filePath, "content");
    await rm(join(tempDir, "nested"));
    expect(await pathExists(join(tempDir, "nested"))).toBe(false);
  });
});

describe("runtime/path", () => {
  test("getModuleDir returns the directory of the current module", () => {
    const dir = getModuleDir(import.meta.url);
    expect(dir).toBeTruthy();
    expect(typeof dir).toBe("string");
    // Should end with the runtime directory name
    expect(dir.endsWith("lib/runtime") || dir.endsWith("lib\\runtime")).toBe(true);
  });
});

describe("runtime/args", () => {
  test("getArgs returns process.argv.slice(2)", () => {
    const args = getArgs();
    expect(Array.isArray(args)).toBe(true);
    // In test context there may or may not be extra args
    expect(args).toEqual(process.argv.slice(2));
  });
});

describe("runtime/stdin", () => {
  let originalStdin: typeof process.stdin;
  let originalStdout: typeof process.stdout;

  beforeEach(() => {
    originalStdin = process.stdin;
    originalStdout = process.stdout;
  });

  afterEach(() => {
    (process as unknown as Record<string, unknown>).stdin = originalStdin;
    (process as unknown as Record<string, unknown>).stdout = originalStdout;
  });

  test("askConfirm resolves true for 'y'", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    (process as unknown as Record<string, unknown>).stdin = input;
    (process as unknown as Record<string, unknown>).stdout = output;

    const promise = askConfirm("Continue");
    input.write("y\n");
    input.end();

    const result = await promise;
    expect(result).toBe(true);
  });

  test("askConfirm resolves false for 'n'", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    (process as unknown as Record<string, unknown>).stdin = input;
    (process as unknown as Record<string, unknown>).stdout = output;

    const promise = askConfirm("Continue");
    input.write("n\n");
    input.end();

    const result = await promise;
    expect(result).toBe(false);
  });

  test("askConfirm resolves true for empty input (default)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    (process as unknown as Record<string, unknown>).stdin = input;
    (process as unknown as Record<string, unknown>).stdout = output;

    const promise = askConfirm("Continue");
    input.write("\n");
    input.end();

    const result = await promise;
    expect(result).toBe(true);
  });

  test("askConfirm preserves answers buffered in one piped chunk across sequential calls", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    (process as unknown as Record<string, unknown>).stdin = input;
    (process as unknown as Record<string, unknown>).stdout = output;

    // All three answers arrive in a single chunk (piped input). Extra lines
    // must survive the first readline interface closing.
    const first = askConfirm("First");
    input.write("y\nn\ny\n");
    input.end();

    expect(await first).toBe(true);
    expect(await askConfirm("Second")).toBe(false);
    expect(await askConfirm("Third")).toBe(true);
  });

  test("askConfirm re-prompts on invalid input before accepting an answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    (process as unknown as Record<string, unknown>).stdin = input;
    (process as unknown as Record<string, unknown>).stdout = output;

    const promise = askConfirm("Continue");
    input.write("maybe\nn\n");
    input.end();

    expect(await promise).toBe(false);
  });

  test("askConfirm resolves false on EOF without user input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    (process as unknown as Record<string, unknown>).stdin = input;
    (process as unknown as Record<string, unknown>).stdout = output;

    const promise = askConfirm("Continue");
    // Immediately end without writing any answer
    input.end();

    const result = await promise;
    expect(result).toBe(false);
  });
});

describe("runtime/terminal", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetTerminalDetectionForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetTerminalDetectionForTests();
  });

  test("hasUtf8Locale detects UTF-8 locale names", () => {
    process.env.LC_ALL = "en_US.UTF-8";
    delete process.env.LC_CTYPE;
    delete process.env.LANG;
    expect(hasUtf8Locale()).toBe(true);

    process.env.LC_ALL = "C";
    expect(hasUtf8Locale()).toBe(false);
  });

  test("uiSymbols uses ASCII separators when locale is not UTF-8 and terminal is basic", () => {
    process.env.LC_ALL = "C";
    process.env.LANG = "C";
    delete process.env.TERM_PROGRAM;
    delete process.env.WT_SESSION;
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.TERM = "linux";

    const symbols = uiSymbols();
    expect(symbols.sep).toBe(" | ");
    expect(symbols.scrollArrows).toBe("Up/Down");
    expect(symbols.listBullet).toBe("-");

    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("configureTerminalEncoding sets a valid UTF-8 locale env when missing", () => {
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    delete process.env.LANG;

    configureTerminalEncoding();
    // Read via an indirection: TS narrows the deleted properties to `undefined`
    // and doesn't see configureTerminalEncoding's mutation.
    const env: Record<string, string | undefined> = process.env;
    const expected = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
    expect(env.LC_CTYPE).toBe(expected);
    expect(env.LANG).toBe(expected);
  });

  test("uiSymbols keeps the ASCII fallback after configureTerminalEncoding forces UTF-8 env", () => {
    process.env.LC_ALL = "C";
    process.env.LANG = "C";
    delete process.env.LC_CTYPE;
    delete process.env.TERM_PROGRAM;
    delete process.env.WT_SESSION;
    delete process.env.TERMINAL_EMULATOR;
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.TERM = "linux";

    try {
      // Regression: this used to write LANG=UTF-8 and thereby flip
      // hasUtf8Locale() to true, making the ASCII fallback unreachable.
      configureTerminalEncoding();
      const symbols = uiSymbols();
      expect(symbols.sep).toBe(" | ");
      expect(symbols.scrollArrows).toBe("Up/Down");
      expect(symbols.listBullet).toBe("-");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
