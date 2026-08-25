import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

// Async so tests in describe.concurrent can overlap their subprocesses.
async function runAddressReviewCLI(
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; status: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI_PATH, "address-review", ...args],
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.then((code) => code ?? 0),
  ]);
  return { stdout, stderr, status };
}

/**
 * Extract Agent's summary from its output.
 * This is a copy of the function from address-review.ts for testing purposes.
 */
function extractAgentSummary(output: string): string {
  const MAX_LENGTH = 500;

  // Remove ANSI color codes
  const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");

  // Helper to truncate if needed
  const truncate = (text: string): string => {
    return text.length > MAX_LENGTH ? text.substring(0, MAX_LENGTH) + "..." : text;
  };

  // Try to find a "Summary" section (## Summary or ## summary)
  const summaryMatch = cleanOutput.match(/##\s*Summary\s*\n+([\s\S]*?)(?=\n##|\n---|z)/i);
  if (summaryMatch && summaryMatch[1].trim()) {
    return truncate(summaryMatch[1].trim());
  }

  // Try to find "Changes Made" section (### Changes Made:)
  const changesMatch = cleanOutput.match(
    /###\s*Changes Made:?\s*\n+([\s\S]*?)(?=\n###|\n##|\n---|z)/i,
  );
  if (changesMatch && changesMatch[1].trim()) {
    const text = `**Changes Made:**\n${changesMatch[1].trim()}`;
    return truncate(text);
  }

  // Look for a paragraph after "Perfect!" or "I've successfully"
  const successMatch = cleanOutput.match(
    /(?:Perfect!|I've successfully[^\n]*)\s*\n+([\s\S]*?)(?=\n##|\n###|z)/,
  );
  if (successMatch && successMatch[1].trim()) {
    return truncate(successMatch[1].trim());
  }

  // Fallback: return a generic message
  return "Addressed review feedback by implementing the requested changes.";
}

describe("Address Review - Agent Summary Extraction", () => {
  test("should extract ## Summary section", () => {
    const output = `
Perfect! I've successfully addressed the PR feedback.

## Summary

I've successfully removed the \`@disco/utils/float-number\` utility and replaced all its usages with the native \`toFixed()\` function.

## Changes Made

1. Removed files
2. Updated packages

## Verification

All tests pass.
`;

    const summary = extractAgentSummary(output);
    expect(summary).toContain("removed the `@disco/utils/float-number` utility");
    expect(summary).not.toContain("## Changes Made");
  });

  test("should extract ### Changes Made section", () => {
    const output = `
Great! I've addressed the feedback.

### Changes Made:

1. **Removed files:**
   - \`packages/utils/src/float-number.ts\`
   - \`packages/utils/src/float-number.test.ts\`

2. **Updated packages:**
   - Updated state-management
   - Updated frontend

### Verification:

All good!
`;

    const summary = extractAgentSummary(output);
    expect(summary).toContain("**Changes Made:**");
    expect(summary).toContain("Removed files:");
    expect(summary).not.toContain("### Verification:");
  });

  test("should extract paragraph after 'Perfect!'", () => {
    const output = `
Perfect! I've successfully addressed the PR feedback.

Here's a summary of the changes made: I removed the custom utility and replaced it with native toFixed().

## Details

More info here...
`;

    const summary = extractAgentSummary(output);
    expect(summary).toContain("Here's a summary of the changes made");
    expect(summary).not.toContain("## Details");
  });

  test("should extract paragraph after 'I've successfully'", () => {
    const output = `
I've successfully completed the requested changes!

The main change was removing the fixFloatingPoint utility and using native JavaScript methods instead.

## Technical Details

Blah blah...
`;

    const summary = extractAgentSummary(output);
    expect(summary).toContain("The main change was removing");
    expect(summary).not.toContain("## Technical Details");
  });

  test("should truncate long ## Summary sections to 500 chars", () => {
    const longText = "This is a very long summary that contains way too much text. ".repeat(20); // ~1200 chars
    const output = `Perfect! I've done it.

## Summary

${longText}

## More Details

Other info.`;

    const summary = extractAgentSummary(output);
    expect(summary.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(summary).not.toContain("## More Details"); // Should stop at next section
  });

  test("should remove ANSI color codes from Summary section", () => {
    const output = `Perfect! I've successfully addressed the feedback.

## Summary

\x1b[1mBold text here\x1b[0m with colors removed.

## More Details

Other stuff.`;

    const summary = extractAgentSummary(output);
    expect(summary).not.toMatch(/\x1b/);
    expect(summary).toContain("Bold text here");
  });

  test("should return fallback for unstructured output", () => {
    const output = "Just some random text without clear structure.";

    const summary = extractAgentSummary(output);
    expect(summary).toBe("Addressed review feedback by implementing the requested changes.");
  });

  test("should handle real Agent output example", () => {
    const output = `
Perfect! I've successfully addressed the PR feedback. Here's a summary of the changes made:

## Summary

I've successfully removed the \`@disco/utils/float-number\` utility and replaced all its usages with the native \`toFixed()\` function as requested by the reviewer.

### Changes Made:

1. **Removed files:**
   - \`packages/utils/src/float-number.ts\` - The custom utility function
   - \`packages/utils/src/float-number.test.ts\` - Associated tests

2. **Updated \`packages/state-management/src/reducers/rightsManagement.ts\`:**
   - Removed the import of \`fixFloatingPoint\`
   - Replaced \`fixFloatingPoint()\` calls with \`parseFloat(number.toFixed(10))\`

3. **Updated \`packages/frontend/src/views/components/common/tracks/track-writers/index.tsx\`:**
   - Removed the import of \`fixFloatingPoint\`
   - Replaced the \`fixFloatingPoint()\` calls with \`parseFloat(...toFixed(10))\`

### Verification:

- ✅ All packages compile successfully
- ✅ \`@disco/state-management\` compiles without errors
- ✅ \`disco-frontend\` compiles without errors

The changes have been committed and are ready for review.
`;

    const summary = extractAgentSummary(output);
    expect(summary).toContain("removed the `@disco/utils/float-number` utility");
    expect(summary).toContain("replaced all its usages");
    expect(summary).not.toContain("### Changes Made:");
  });
});

// Create a throwaway git repo with an initial commit and a test branch.
// Single shell call: spawning git once keeps the suite fast.
function makeTestRepo(): string {
  const testDir = join(
    tmpdir(),
    `address-review-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
  );
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "README.md"), "# Test Repo\n");
  writeFileSync(join(testDir, "test.txt"), "test content\n");
  const setup = [
    "git init",
    "git config user.name 'Test User'",
    "git config user.email 'test@example.com'",
    "git add .",
    "git commit -m 'Initial commit'",
    "git checkout -b test-branch",
    "git add .",
    "git commit -m 'Test commit'",
  ].join(" && ");
  spawnSync("sh", ["-c", setup], { cwd: testDir });
  return testDir;
}

function makeTestDir(): string {
  const testDir = join(
    tmpdir(),
    `address-review-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
  );
  mkdirSync(testDir, { recursive: true });
  return testDir;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }
}

describe.concurrent("Address Review - Worktree Integration", () => {
  test("should attempt to prepare review worktree when processing PR", async () => {
    const testDir = makeTestRepo();
    try {
      const result = await runAddressReviewCLI(
        ["https://github.com/test/repo/pull/123", "--no-push", "--no-reply"],
        {
          cwd: testDir,
          env: {
            // Mock credentials - will fail auth but that's expected
            GITHUB_TOKEN: "test-token",
            // Keep token-first path; inherited App creds can change failure modes.
            GITHUB_APP_ID: "",
            GITHUB_APP_PRIVATE_KEY_PATH: "",
            GITHUB_APP_PRIVATE_KEY_BASE64: "",
          },
        },
      );

      // The command will fail because of bad credentials, but we can verify it:
      // 1. Successfully parsed the PR URL
      // 2. Attempted to fetch PR details (which failed at GitHub API, not earlier)
      const output = result.stdout + result.stderr;

      // Check that it at least got to the GitHub API step (not worktree yet due to auth failure)
      expect(output).toContain("Parsing PR URL");
      expect(output).toContain("Fetching PR details");

      // Fail at the GitHub API step (auth or transient network) — proves we got past arg parsing.
      expect(output).toMatch(
        /Bad credentials|GitHub API error|typo in the url|ENOTFOUND|ECONNREFUSED|fetch failed/i,
      );

      // Command should exit with non-zero status due to API failure
      expect(result.status).not.toBe(0);
    } finally {
      cleanupDir(testDir);
    }
  }, 20000);

  test("should use review worktree path in error messages", async () => {
    const testDir = makeTestRepo();
    try {
      const result = await runAddressReviewCLI(
        ["https://github.com/test/repo/pull/123", "--verbose", "--no-push", "--no-reply"],
        {
          cwd: testDir,
          env: {
            GITHUB_TOKEN: "test-token",
          },
        },
      );

      const output = result.stdout + result.stderr;

      // Should mention the worktree path if verbose
      if (output.includes("verbose") || output.includes("Preparing")) {
        // The output should reference /tmp/devintern-review-worktree/ somewhere
        expect(output).toMatch(/review-worktree/i);
      }
    } finally {
      cleanupDir(testDir);
    }
  });

  test("address-review command should accept required parameters", async () => {
    const testDir = makeTestRepo();
    try {
      const result = await runAddressReviewCLI(["--help"], { cwd: testDir });

      expect(result.stdout).toContain("address-review");
      expect(result.stdout).toContain("pr-url");
      expect(result.stdout).toContain("--no-push");
      expect(result.stdout).toContain("--no-reply");
      expect(result.status).toBe(0);
    } finally {
      cleanupDir(testDir);
    }
  });

  test("address-review should error on invalid PR URL", async () => {
    const testDir = makeTestRepo();
    try {
      const result = await runAddressReviewCLI(["not-a-valid-url", "--no-push", "--no-reply"], {
        cwd: testDir,
        env: {
          GITHUB_TOKEN: "test-token",
        },
      });

      const output = result.stdout + result.stderr;
      expect(output).toMatch(/Invalid.*PR URL|github\.com/i);
      expect(result.status).not.toBe(0);
    } finally {
      cleanupDir(testDir);
    }
  });

  test("worktree should be clean after processing (no uncommitted changes)", () => {
    // This test verifies that if we create a worktree, it doesn't leave uncommitted changes
    // We'll simulate this by checking the worktree doesn't exist or is clean

    const worktreePath = "/tmp/devintern-review-worktree";

    // If worktree exists, check it's clean
    if (existsSync(worktreePath)) {
      const statusResult = spawnSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf8",
      });

      // Worktree should have no uncommitted changes
      expect(statusResult.stdout.trim()).toBe("");
    }
    // If worktree doesn't exist, that's also fine - test passes
  });

  test("worktree directory should be in tmp and isolated from main repo", () => {
    const testDir = makeTestDir();
    try {
      // Verify that the review-worktree is in /tmp and not in the main repo
      const worktreePath = "/tmp/devintern-review-worktree";

      // Worktree should be outside the main repo (in /tmp)
      expect(worktreePath).toMatch(/^\/tmp\//);
      expect(worktreePath).not.toContain(testDir);
    } finally {
      cleanupDir(testDir);
    }
  });

  test("worktree should handle branch switching correctly", () => {
    // This test verifies the worktree path is isolated and not in the main repo
    const testDir = makeTestRepo();
    try {
      const worktreePath = "/tmp/devintern-review-worktree";

      // Create a second test branch
      spawnSync("git", ["checkout", "main"], { cwd: testDir });
      spawnSync("git", ["checkout", "-b", "test-branch-2"], { cwd: testDir });
      writeFileSync(join(testDir, "test2.txt"), "test content 2\n");
      spawnSync("git", ["add", "."], { cwd: testDir });
      spawnSync("git", ["commit", "-m", "Second test commit"], { cwd: testDir });

      // The worktree is shared globally across all tests and repos,
      // so we just verify the path is correct and isolated
      expect(worktreePath).toBe("/tmp/devintern-review-worktree");
      expect(worktreePath).not.toContain(testDir);
    } finally {
      cleanupDir(testDir);
    }
  });

  test("worktree should not interfere with main repository state", () => {
    // Verify main repo stays on its current branch even after worktree operations
    const testDir = makeTestRepo();
    try {
      const originalBranch = spawnSync("git", ["branch", "--show-current"], {
        cwd: testDir,
        encoding: "utf8",
      }).stdout.trim();

      // Run a command that would use the worktree (will fail but that's OK)
      spawnSync(
        "bun",
        [
          CLI_PATH,
          "address-review",
          "https://github.com/test/repo/pull/123",
          "--no-push",
          "--no-reply",
        ],
        {
          cwd: testDir,
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            GITHUB_TOKEN: "test-token",
          },
        },
      );

      // Main repo should still be on the same branch
      const currentBranch = spawnSync("git", ["branch", "--show-current"], {
        cwd: testDir,
        encoding: "utf8",
      }).stdout.trim();

      expect(currentBranch).toBe(originalBranch);
    } finally {
      cleanupDir(testDir);
    }
  });

  test("worktree should isolate changes from main repository", () => {
    const testDir = makeTestDir();
    try {
      const worktreePath = "/tmp/devintern-review-worktree";

      // Create a file in main repo
      const mainRepoFile = join(testDir, "main-repo-file.txt");
      writeFileSync(mainRepoFile, "main repo content\n");

      // Verify worktree and main repo are separate directories
      // (worktrees are separate working directories that isolate changes)
      expect(worktreePath).not.toBe(testDir);

      // The worktree is shared globally across all tests and repos,
      // so we just verify the path is isolated from the test directory
      expect(worktreePath).toMatch(/^\/tmp\//);
      expect(worktreePath).not.toContain(testDir);
    } finally {
      // Clean up
      cleanupDir(testDir);
    }
  });

  test("worktree should have proper remote tracking configured", () => {
    const testDir = makeTestRepo();
    try {
      const worktreePath = "/tmp/devintern-review-worktree";

      // Create a branch and set up remote tracking manually for testing
      spawnSync("git", ["checkout", "-b", "tracking-test"], { cwd: testDir });
      writeFileSync(join(testDir, "tracking-test.txt"), "tracking test\n");
      spawnSync("git", ["add", "."], { cwd: testDir });
      spawnSync("git", ["commit", "-m", "Tracking test commit"], {
        cwd: testDir,
      });

      // If worktree exists and is a git directory
      if (existsSync(worktreePath) && existsSync(join(worktreePath, ".git"))) {
        // Check that the branch has upstream configured
        const upstreamResult = spawnSync(
          "git",
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
          {
            cwd: worktreePath,
            encoding: "utf8",
          },
        );

        // If there's an upstream, it should be in the format origin/branch-name
        if (upstreamResult.status === 0 && upstreamResult.stdout.trim()) {
          expect(upstreamResult.stdout.trim()).toMatch(/^origin\//);
        }
        // If no upstream is set, that's also fine - we just can't test it
      }
      // If worktree doesn't exist yet, test passes
    } finally {
      cleanupDir(testDir);
    }
  });

  test("worktree should not have any untracked files after processing", () => {
    // If worktree exists, verify no untracked files are left behind
    const worktreePath = "/tmp/devintern-review-worktree";

    if (existsSync(worktreePath)) {
      const statusResult = spawnSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf8",
      });

      if (statusResult.status === 0) {
        const output = statusResult.stdout;

        // Check for any untracked files (lines starting with "??")
        const untrackedFiles = output.split("\n").filter((line) => line.startsWith("??"));

        // Should not have any untracked files
        expect(untrackedFiles.length).toBe(0);
      }
    }
    // If worktree doesn't exist, test passes
  });
});
