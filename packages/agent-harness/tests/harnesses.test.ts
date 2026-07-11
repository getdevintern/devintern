import { describe, expect, test } from "bun:test";

import { AntigravityHarness } from "../src/harnesses/antigravity.js";
import { ClaudeCodeHarness } from "../src/harnesses/claude-code.js";
import { ClineHarness } from "../src/harnesses/cline.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { CursorHarness } from "../src/harnesses/cursor.js";
import { DeepSeekHarness } from "../src/harnesses/deepseek.js";
import { GeminiHarness } from "../src/harnesses/gemini.js";
import { GooseHarness } from "../src/harnesses/goose.js";
import { GrokHarness } from "../src/harnesses/grok.js";
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
    expect(h.defaultPath).toBe("cursor-agent");
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

describe("AntigravityHarness", () => {
  const h = new AntigravityHarness();

  test("metadata", () => {
    expect(h.name).toBe("antigravity");
    expect(h.displayName).toBe("Antigravity CLI");
    expect(h.defaultPath).toBe("agy");
    expect(h.promptFlag).toBe("-p");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual([]);
  });

  test("buildArgs with skipPermissions", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual(["--dangerously-skip-permissions"]);
  });

  test("buildArgs does not emit yolo/skip flags when skipPermissions is false", () => {
    expect(h.buildArgs({ skipPermissions: false })).toEqual([]);
  });

  test("buildArgs ignores model and maxTurns (not stable CLI flags)", () => {
    expect(h.buildArgs({ model: "gemini-3.5-flash", maxTurns: 10 })).toEqual([]);
  });
});

describe("GeminiHarness (deprecated re-export)", () => {
  test("is AntigravityHarness (does not target the retired gemini binary)", () => {
    const h = new GeminiHarness();
    expect(h).toBeInstanceOf(AntigravityHarness);
    expect(h.name).toBe("antigravity");
    expect(h.defaultPath).toBe("agy");
    expect(h.buildArgs({ skipPermissions: true })).toEqual(["--dangerously-skip-permissions"]);
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
    expect(h.buildArgs({ skipPermissions: true, model: "gpt-4", workingDir: "/tmp/wt" })).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "--dir",
      "/tmp/wt",
      "--model",
      "gpt-4",
    ]);
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

describe("GrokHarness", () => {
  const h = new GrokHarness();

  test("metadata", () => {
    expect(h.name).toBe("grok");
    expect(h.displayName).toBe("Grok Build");
    expect(h.defaultPath).toBe("grok");
    expect(h.promptFlag).toBe("-p");
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["--no-auto-update"]);
  });

  test("buildArgs with all options", () => {
    expect(
      h.buildArgs({
        skipPermissions: true,
        model: "grok-4.5",
        workingDir: "/tmp/wt",
      }),
    ).toEqual(["--no-auto-update", "--always-approve", "-m", "grok-4.5", "--cwd", "/tmp/wt"]);
  });

  test("buildArgs ignores maxTurns (not supported)", () => {
    expect(h.buildArgs({ maxTurns: 10 })).toEqual(["--no-auto-update"]);
  });
});

describe("DeepSeekHarness", () => {
  const h = new DeepSeekHarness();

  test("metadata", () => {
    expect(h.name).toBe("deepseek");
    expect(h.displayName).toBe("Reasonix");
    expect(h.defaultPath).toBe("reasonix");
    expect(h.promptFlag).toBeUndefined();
  });

  test("buildArgs empty", () => {
    expect(h.buildArgs({})).toEqual(["run"]);
  });

  test("buildArgs with model", () => {
    expect(h.buildArgs({ model: "deepseek-pro" })).toEqual(["run", "--model", "deepseek-pro"]);
  });

  test("buildArgs ignores skipPermissions and maxTurns", () => {
    expect(h.buildArgs({ skipPermissions: true, maxTurns: 10 })).toEqual(["run"]);
  });
});
