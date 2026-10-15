import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  buildInjectedTaskMarkdown,
  deriveInjectedTaskKey,
  parseWorkerAddArgs,
  runWorkerAdd,
  slugifyTitle,
} from "../src/lib/workspace/add-command";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { workspaceDbPath } from "../src/lib/workspace/paths";

const WORKSPACE_TOML = `[workspace]
dashboard = false

[defaults]
tracker = "markdown"
worker_task_args = "--no-git"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`;

describe("worker add argument parsing", () => {
  test("parses the documented flags", () => {
    const parsed = parseWorkerAddArgs([
      "--repo",
      "backend",
      "--title",
      "Fix the flake",
      "--body",
      "details",
      "--idempotency-key",
      "run-1",
      "--wait",
      "--json",
    ]);
    expect(parsed).toEqual({
      kind: "ok",
      options: {
        repo: "backend",
        title: "Fix the flake",
        body: "details",
        idempotencyKey: "run-1",
        wait: true,
        json: true,
      },
    });
  });

  test("treats -h/--help as help", () => {
    expect(parseWorkerAddArgs(["--help"]).kind).toBe("help");
    expect(parseWorkerAddArgs(["-h"]).kind).toBe("help");
  });

  test("rejects a missing title, unknown flags, and conflicting body flags", () => {
    expect(parseWorkerAddArgs(["--repo", "backend"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--title", "x", "--nope"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--title", "x", "--body", "a", "--body-file", "b"]).kind).toBe(
      "error",
    );
    expect(parseWorkerAddArgs(["--repo"]).kind).toBe("error");
  });

  test("accepts '-' as the --body-file stdin sentinel", () => {
    const parsed = parseWorkerAddArgs(["--title", "x", "--body-file", "-"]);
    expect(parsed).toMatchObject({ kind: "ok", options: { bodyFile: "-" } });
  });
});

describe("worker add key and markdown helpers", () => {
  test("slugifies and derives collision-free local keys", () => {
    expect(slugifyTitle("Fix: Flaky Test (v2)")).toBe("fix-flaky-test-v2");
    const taken = new Set(["local-fix-flaky-test", "local-fix-flaky-test-2"]);
    expect(deriveInjectedTaskKey("Fix flaky test", (key) => taken.has(key))).toBe(
      "local-fix-flaky-test-3",
    );
  });

  test("renders a markdown task with the key in frontmatter", () => {
    const markdown = buildInjectedTaskMarkdown({
      taskKey: "local-bump-deps",
      title: "Bump dependencies",
      body: "Update lockfile.",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(markdown).toContain("key: local-bump-deps");
    expect(markdown).toContain("created_at: 2026-01-02T03:04:05.000Z");
    expect(markdown).toContain("# Bump dependencies");
    expect(markdown).toContain("Update lockfile.");
  });
});

describe("runWorkerAdd", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `worker-add-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "workspace.toml");
    writeFileSync(configPath, WORKSPACE_TOML);
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
  });

  afterEach(() => {
    delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
    rmSync(dir, { recursive: true, force: true });
  });

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      options: {
        log: (message: string) => out.push(message),
        error: (message: string) => err.push(message),
        readStdin: () => "piped body\n",
      },
    };
  }

  test("enqueues a durable task for the named repo and emits JSON", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Fix flaky test", "--json"],
      cap.options,
    );
    expect(code).toBe(0);

    const result = JSON.parse(cap.out.at(-1)!);
    expect(result).toMatchObject({
      taskKey: "local-fix-flaky-test",
      repo: "backend",
      status: "pending",
      deduplicated: false,
    });

    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      const task = store.getById(result.id)!;
      expect(task.repo).toBe("backend");
      expect(task.actor).toBe("local:add");
      expect(existsSync(task.taskFile)).toBe(true);
      expect(readFileSync(task.taskFile, "utf8")).toContain("key: local-fix-flaky-test");
    } finally {
      store.close();
    }
  });

  test("reads the body from stdin for --body-file -", async () => {
    const cap = capture();
    await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Piped",
        "--body-file",
        "-",
        "--json",
      ],
      cap.options,
    );
    const result = JSON.parse(cap.out.at(-1)!);
    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      expect(store.getById(result.id)!.body).toBe("piped body\n");
    } finally {
      store.close();
    }
  });

  test("defaults to the only repo and is idempotent on the key", async () => {
    writeFileSync(
      configPath,
      WORKSPACE_TOML.replace(/\n\[\[repos\]\]\nname = "web"[\s\S]*$/, "\n"),
    );
    const cap = capture();
    const args = [
      "--workspace",
      configPath,
      "--title",
      "Bump deps",
      "--idempotency-key",
      "nightly-42",
      "--json",
    ];
    await runWorkerAdd(args, cap.options);
    const first = JSON.parse(cap.out.at(-1)!);
    expect(first.repo).toBe("backend");

    const second = capture();
    await runWorkerAdd(args, second.options);
    const dedup = JSON.parse(second.out.at(-1)!);
    expect(dedup.deduplicated).toBe(true);
    expect(dedup.id).toBe(first.id);

    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      expect(store.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("fails clearly for an unknown repo and lists valid names", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "nope", "--title", "x"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain('Unknown repo "nope"');
    expect(cap.err.join("\n")).toContain("backend, web");
  });

  test("fails clearly when --repo is omitted with multiple repos", async () => {
    const cap = capture();
    const code = await runWorkerAdd(["--workspace", configPath, "--title", "x"], cap.options);
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("--repo is required");
    expect(cap.err.join("\n")).toContain("backend, web");
  });

  test("rejects an empty title and an oversized body", async () => {
    const empty = capture();
    expect(await runWorkerAdd(["--workspace", configPath, "--title", "   "], empty.options)).toBe(
      1,
    );
    expect(empty.err.join("\n")).toContain("--title is required");

    const big = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "x",
        "--body",
        "a".repeat(20_001),
      ],
      big.options,
    );
    expect(code).toBe(1);
    expect(big.err.join("\n")).toContain("Body is too large");
  });

  test("fails when the workspace has no workspace.toml", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", join(dir, "missing", "workspace.toml"), "--title", "x"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("No workspace.toml");
  });

  test("--wait fails fast when no worker is running", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Wait", "--wait"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("--wait needs a running worker");
  });
});
