import { describe, expect, test } from "bun:test";

import { ClaudeCodeHarness } from "../src/harnesses/claude-code.js";
import { ClineHarness } from "../src/harnesses/cline.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { CursorHarness } from "../src/harnesses/cursor.js";
import { GeminiHarness } from "../src/harnesses/gemini.js";
import { GooseHarness } from "../src/harnesses/goose.js";
import { KiloCodeHarness } from "../src/harnesses/kilo-code.js";
import { KimiHarness } from "../src/harnesses/kimi.js";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import { PiHarness } from "../src/harnesses/pi.js";
import { QwenCodeHarness } from "../src/harnesses/qwen.js";

describe("ClaudeCodeHarness", () => {
  const h = new ClaudeCodeHarness();

  test("metadata", () => {
    expect(h.name).toBe("claude-code");
    expect(h.displayName).toBe("Claude Code");
    expect(h.defaultPath).toBe("claude");
    expect(h.promptFlag).toBe("-p");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual([]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "opus", maxTurns: 5 })).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "--max-turns",
      "5",
    ]);
  });

  test("buildArgs partial options", () => {
    expect(h.buildArgs({ model: "sonnet" })).toEqual(["--model", "sonnet"]);
  });
});

describe("ClineHarness", () => {
  const h = new ClineHarness();

  test("metadata", () => {
    expect(h.name).toBe("cline");
    expect(h.displayName).toBe("Cline");
    expect(h.defaultPath).toBe("cline");
    expect(h.promptFlag).toBeUndefined();
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["task"]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "gpt-4" })).toEqual([
      "task",
      "--yolo",
      "--model",
      "gpt-4",
    ]);
  });
});

describe("CodexHarness", () => {
  const h = new CodexHarness();

  test("metadata", () => {
    expect(h.name).toBe("codex");
    expect(h.displayName).toBe("Codex");
    expect(h.defaultPath).toBe("codex");
    expect(h.promptFlag).toBeUndefined();
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["exec"]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "gpt-4o" })).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--model",
      "gpt-4o",
    ]);
  });
});

describe("CursorHarness", () => {
  const h = new CursorHarness();

  test("metadata", () => {
    expect(h.name).toBe("cursor");
    expect(h.displayName).toBe("Cursor");
    expect(h.defaultPath).toBe("agent");
    expect(h.promptFlag).toBeUndefined();
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["-p"]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "claude-3" })).toEqual([
      "-p",
      "--force",
      "--trust",
      "--approve-mcps",
      "--model",
      "claude-3",
    ]);
  });
});

describe("GeminiHarness", () => {
  const h = new GeminiHarness();

  test("metadata", () => {
    expect(h.name).toBe("gemini");
    expect(h.displayName).toBe("Gemini CLI");
    expect(h.defaultPath).toBe("gemini");
    expect(h.promptFlag).toBe("-p");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual([]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "gemini-pro" })).toEqual([
      "--approval-mode=yolo",
      "--model",
      "gemini-pro",
    ]);
  });
});

describe("GooseHarness", () => {
  const h = new GooseHarness();

  test("metadata", () => {
    expect(h.name).toBe("goose");
    expect(h.displayName).toBe("Goose");
    expect(h.defaultPath).toBe("goose");
    expect(h.promptFlag).toBe("-t");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["run"]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "gpt-4" })).toEqual([
      "run",
      "--no-session",
      "--model",
      "gpt-4",
    ]);
  });
});

describe("KiloCodeHarness", () => {
  const h = new KiloCodeHarness();

  test("metadata", () => {
    expect(h.name).toBe("kilo-code");
    expect(h.displayName).toBe("Kilo Code");
    expect(h.defaultPath).toBe("kilo");
    expect(h.promptFlag).toBeUndefined();
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["run"]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "claude" })).toEqual([
      "run",
      "--auto",
      "--model",
      "claude",
    ]);
  });
});

describe("KimiHarness", () => {
  const h = new KimiHarness();

  test("metadata", () => {
    expect(h.name).toBe("kimi");
    expect(h.displayName).toBe("Kimi CLI");
    expect(h.defaultPath).toBe("kimi");
    expect(h.promptFlag).toBe("--prompt");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["--print"]);
  });

  test("buildArgs with all options", () => {
    expect(h.buildArgs({ skipPermissions: true, model: "kimi-k2" })).toEqual([
      "--print",
      "--yolo",
      "--model",
      "kimi-k2",
    ]);
  });
});

describe("OpencodeHarness", () => {
  const h = new OpencodeHarness();

  test("metadata", () => {
    expect(h.name).toBe("opencode");
    expect(h.displayName).toBe("Opencode");
    expect(h.defaultPath).toBe("opencode");
    expect(h.promptFlag).toBeUndefined();
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["run"]);
  });

  test("buildArgs with all options", () => {
    expect(
      h.buildArgs({ skipPermissions: true, model: "gpt-4", workingDir: "/tmp/wt" }),
    ).toEqual(["run", "--dangerously-skip-permissions", "--dir", "/tmp/wt", "--model", "gpt-4"]);
  });

  test("buildArgs forwards workingDir as --dir (opencode ignores spawn cwd)", () => {
    expect(h.buildArgs({ workingDir: "/tmp/devintern-review-worktree-feature-x" })).toEqual([
      "run",
      "--dir",
      "/tmp/devintern-review-worktree-feature-x",
    ]);
  });
});

describe("PiHarness", () => {
  const h = new PiHarness();

  test("metadata", () => {
    expect(h.name).toBe("pi");
    expect(h.displayName).toBe("Pi");
    expect(h.defaultPath).toBe("pi");
    expect(h.promptFlag).toBe("-p");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual([]);
  });
});

describe("QwenCodeHarness", () => {
  const h = new QwenCodeHarness();

  test("metadata", () => {
    expect(h.name).toBe("qwen");
    expect(h.displayName).toBe("Qwen Code");
    expect(h.defaultPath).toBe("qwen");
    expect(h.promptFlag).toBe("-p");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual([]);
  });

  test("buildArgs with skipPermissions", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual(["--yolo"]);
  });

  test("buildArgs ignores model (not supported)", () => {
    expect(h.buildArgs({ model: "qwen-coder" })).toEqual([]);
  });
});
