import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { detectMiseShim, miseShimFixHint } from "../src/sandbox/shim-detect.js";

const dirs: string[] = [];

function tempScript(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devintern-shim-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectMiseShim", () => {
  test("detects a mise use/x wrapper script", () => {
    const path = tempScript(
      "grok",
      [
        "#!/bin/sh",
        'mise use -g --quiet "npm:@xai-official/grok" || exit 1',
        'exec mise x "npm:@xai-official/grok" -- "grok" "$@"',
      ].join("\n"),
    );
    const info = detectMiseShim(path);
    expect(info.shim).toBe(true);
    expect(info.path).toBe(path);
    expect(info.match).toContain("mise use");
  });

  test("ignores an ordinary executable", () => {
    const path = tempScript("opencode", "#!/bin/sh\nexec /opt/opencode/bin/opencode \"$@\"\n");
    expect(detectMiseShim(path).shim).toBe(false);
  });

  test("builds the exact per-harness CLI path fix", () => {
    expect(miseShimFixHint("grok")).toBe("GROK_CLI_PATH=/path/to/grok");
    expect(miseShimFixHint("claude-code")).toBe("CLAUDE_CLI_PATH=/path/to/claude-code");
  });
});
