import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

// Helper to run the CLI in an isolated directory to avoid lock conflicts
function runCLI(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  // Create unique temp directory for this test run
  const testDir = join(
    tmpdir(),
    `cli-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
  );
  mkdirSync(testDir, { recursive: true });

  try {
    const result = spawnSync("bun", [CLI_PATH, ...args], {
      encoding: "utf8",
      timeout: 5000,
      cwd: testDir, // Run in isolated directory
      env: {
        ...process.env,
        JIRA_BASE_URL: "https://test.atlassian.net",
        JIRA_EMAIL: "test@example.com",
        JIRA_API_TOKEN: "test-token",
        DEVINTERN_SKIP_LICENSE_CHECK: "1",
      },
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status || 0,
    };
  } finally {
    // Clean up temp directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

describe("CLI Argument Handling", () => {
  test("should show help with --help", () => {
    const result = runCLI(["--help"]);
    expect(result.stdout).toContain("devintern");
    expect(result.stdout).toContain("One or more task keys");
    expect(result.stdout).toContain("PROJ-123 PROJ-456 PROJ-789");
    expect(result.stdout).toContain("full card URL");
    expect(result.stdout).toContain(
      "devintern https://trello.com/c/4uWKPOTv/card-slug --create-pr",
    );
    expect(result.stdout).toContain("devintern ./tasks/feature-spec.md --no-git");
    expect(result.stdout).toContain("markdown file paths");
    expect(result.stdout).not.toContain("JIRA task key");
    expect(result.stdout).not.toContain("--no-agent");
    expect(result.stdout).not.toContain("--jql");
    expect(result.stdout).not.toContain("--claude-path");
    expect(result.stdout).not.toContain("--skip-jira-comments");
    expect(result.stdout).toContain("devintern PROJ-123 PROJ-456 PROJ-789 --create-pr");
    expect(result.exitCode).toBe(0);
  });

  test("should show version with --version", () => {
    const result = runCLI(["--version"]);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  test("should handle init command", () => {
    const result = runCLI(["init"]);
    expect(result.stdout).toContain("Initializing @devintern/code");
    expect(result.exitCode).toBe(0);
  });

  test("should accept single task key", () => {
    const result = runCLI(["TEST-123"]);
    // Will fail to fetch from JIRA but should parse arguments correctly
    expect(result.stdout).toContain("Processing");
    expect(result.stdout).toContain("TEST-123");
  });

  test("should accept multiple task keys", () => {
    const result = runCLI(["TEST-123", "TEST-456"]);
    expect(result.stdout).toContain("Processing 2 task");
    expect(result.stdout).toContain("TEST-123");
    expect(result.stdout).toContain("TEST-456");
  });

  test("should handle --query option", () => {
    const result = runCLI(["--query", "project = TEST"]);
    expect(result.stdout).toContain("Searching task tracker with query");
  });

  test("should handle --jql option as deprecated alias for --query", () => {
    const result = runCLI(["--jql", "project = TEST"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("--jql is deprecated");
    expect(result.stdout).toContain("Searching task tracker with query");
  });

  test("should handle --no-git option", () => {
    const result = runCLI(["TEST-123", "--no-git"]);
    // Should not try to create git branch
    expect(result.stdout).not.toContain("Creating feature branch");
  });

  test("should handle --max-turns option", () => {
    const result = runCLI(["TEST-123", "--max-turns", "500"]);
    expect(result.stdout).toContain("Processing");
  });

  test("should handle --create-pr option", () => {
    const result = runCLI(["TEST-123", "--create-pr"]);
    expect(result.stdout).toContain("Processing");
  });

  test("should handle --pr-target-branch option", () => {
    const result = runCLI(["TEST-123", "--create-pr", "--pr-target-branch", "develop"]);
    expect(result.stdout).toContain("Processing");
  });

  test("should handle --skip-clarity-check option", () => {
    const result = runCLI(["TEST-123", "--skip-clarity-check"]);
    expect(result.stdout).not.toContain("clarity assessment");
  });

  test("should handle --skip-comments option", () => {
    const result = runCLI(["TEST-123", "--skip-comments"]);
    expect(result.stdout).toContain("Processing");
  });

  test("should handle --skip-jira-comments as deprecated alias for --skip-comments", () => {
    const result = runCLI(["TEST-123", "--skip-jira-comments"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("--skip-jira-comments is deprecated");
    expect(result.stdout).toContain("Processing");
  });

  test("should handle --verbose option", () => {
    const result = runCLI(["TEST-123", "-v"]);
    // Verbose mode shows resolved agent harness
    expect(result.stdout).toContain("resolved to");
  });

  test("should handle --no-auto-commit option", () => {
    const result = runCLI(["TEST-123", "--no-auto-commit"]);
    expect(result.stdout).toContain("Processing");
  });

  test("should handle --hook-retries option", () => {
    const result = runCLI(["TEST-123", "--hook-retries", "5"]);
    expect(result.stdout).toContain("Processing");
  });

  test("should handle combination of options", () => {
    const result = runCLI([
      "TEST-123",
      "--max-turns",
      "500",
      "--create-pr",
      "--pr-target-branch",
      "master",
      "--skip-clarity-check",
    ]);
    expect(result.stdout).toContain("Processing");
    expect(result.stdout).toContain("TEST-123");
  });

  test("should error when no task keys and no query provided", () => {
    const result = runCLI([]);
    // The error appears in stdout as part of the main() function
    const output = result.stdout + result.stderr;
    expect(output).toContain("No tasks specified");
  });

  test("should accept trello task keys without unsupported tracker error", () => {
    const testDir = require("os").tmpdir() + `/cli-trello-env-test-${Date.now()}`;
    require("fs").mkdirSync(testDir, { recursive: true });
    try {
      const result = spawnSync("bun", [CLI_PATH, "4uWKPOTv"], {
        encoding: "utf8",
        timeout: 5000,
        cwd: testDir,
        env: {
          ...process.env,
          TASK_TRACKER: "trello",
          TRELLO_API_KEY: "test-api-key",
          TRELLO_API_TOKEN: "test-api-token",
          DEVINTERN_SKIP_LICENSE_CHECK: "1",
        },
      });
      const output = (result.stdout || "") + (result.stderr || "");
      expect(output).not.toContain("Unsupported task tracker");
      expect(output).toContain("Fetching task");
    } finally {
      try {
        require("fs").rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("should accept --query with the trello tracker", () => {
    const testDir = require("os").tmpdir() + `/cli-trello-test-${Date.now()}`;
    require("fs").mkdirSync(testDir, { recursive: true });
    try {
      const result = spawnSync("bun", [CLI_PATH, "--query", 'list:"To Do" is:open'], {
        encoding: "utf8",
        timeout: 5000,
        cwd: testDir,
        env: {
          ...process.env,
          TASK_TRACKER: "trello",
          TRELLO_API_KEY: "test-api-key",
          TRELLO_API_TOKEN: "test-api-token",
          DEVINTERN_SKIP_LICENSE_CHECK: "1",
        },
      });
      const output = (result.stdout || "") + (result.stderr || "");
      expect(output).not.toContain("--query is not supported");
      expect(output).toContain("Searching task tracker with query");
    } finally {
      try {
        require("fs").rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("should handle task keys that look like options", () => {
    const result = runCLI(["TEST-123"]);
    expect(result.stdout).toContain("TEST-123");
  });
});

describe("CLI Init Command", () => {
  test("init should not be treated as a task key", () => {
    const result = runCLI(["init"]);
    expect(result.stdout).not.toContain("Fetching JIRA task: init");
    expect(result.stdout).toContain("Initializing @devintern/code");
    expect(result.exitCode).toBe(0);
  });

  test("init should work without other arguments", () => {
    const result = runCLI(["init"]);
    // Check for either success message or "already exists" message
    const hasInitOutput =
      result.stdout.includes("Created configuration folder") ||
      result.stdout.includes("Configuration folder already exists");
    expect(hasInitOutput).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("init should add review worktree and other entries to .gitignore", () => {
    // Create unique temp directory for this test
    const testDir = join(
      tmpdir(),
      `cli-init-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(testDir, { recursive: true });

    try {
      // Run init command in the test directory
      const result = spawnSync("bun", [CLI_PATH, "init"], {
        encoding: "utf8",
        timeout: 5000,
        cwd: testDir,
      });

      expect(result.status).toBe(0);

      // Check that .gitignore was created or updated
      const gitignorePath = join(testDir, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);

      // Read .gitignore and verify all entries are present
      const gitignoreContent = readFileSync(gitignorePath, "utf8");

      // Should contain all the expected entries
      expect(gitignoreContent).toContain(".devintern-code/.env");
      expect(gitignoreContent).toContain(".devintern-code/.env.local");
      expect(gitignoreContent).toContain(".devintern-code/.pid.lock");

      // Should have the comment header
      expect(gitignoreContent).toContain("@devintern/code - Keep credentials secure");
    } finally {
      // Clean up temp directory
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});
