import { describe, expect, test } from "bun:test";

import { listHarnesses } from "../src/registry.js";
import { runAgentBun } from "../src/runners/bun.js";
import { runAgentNode } from "../src/runners/node.js";
import {
  UnsupportedStructuredOutputError,
  assertStructuredOutputSupported,
  parseStructuredOutput,
} from "../src/structured-output.js";
import type { AgentHarness, StructuredOutputResult } from "../src/types.js";

// Realistic CLI output fixtures (shapes verified against upstream docs).
const CLAUDE_ENVELOPE =
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"result":"All tests pass.","session_id":"0b5e1c2a"}';
const CODEX_EVENTS = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
].join("\n");

function harnessWithoutCapability(): AgentHarness {
  return {
    name: "test-text-only",
    displayName: "Text Only",
    defaultPath: "/bin/sh",
    buildArgs: () => [],
  };
}

function emittingHarness(stdoutScript: string): AgentHarness {
  return {
    name: "test-json-emitter",
    displayName: "JSON Emitter",
    defaultPath: "/bin/sh",
    supportsStructuredOutput: true,
    buildArgs: () => ["-c", stdoutScript],
  };
}

/** Assert a run carried a structured result and return it for value checks. */
function expectStructuredPayload(result: { structured?: StructuredOutputResult }): {
  ok: boolean;
  value?: unknown;
  error?: string;
} {
  expect(result.structured).toBeDefined();
  return result.structured as StructuredOutputResult;
}

describe("parseStructuredOutput", () => {
  test("single-line JSON object (Claude Code / Cursor / Grok / agy envelope)", () => {
    const parsed = parseStructuredOutput(CLAUDE_ENVELOPE);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
    const value = parsed.value as { type: string; result: string };
    expect(value.type).toBe("result");
    expect(value.result).toBe("All tests pass.");
  });

  test("pretty-printed JSON object", () => {
    const parsed = parseStructuredOutput(
      `{
  "status": "SUCCESS",
  "response": "A git rebase rewrites history.",
  "num_turns": 1
}`,
    );
    expect(parsed.ok).toBe(true);
    expect((parsed.value as { status: string }).status).toBe("SUCCESS");
  });

  test("JSON array (Qwen buffered messages)", () => {
    const parsed = parseStructuredOutput(
      '[{"type":"system","subtype":"session_start"},{"type":"result","is_error":false,"result":"Paris."}]',
    );
    expect(parsed.ok).toBe(true);
    expect((parsed.value as unknown[]).length).toBe(2);
  });

  test("NDJSON event stream (Codex / Opencode / Kilo / Cline / Kimi / Pi)", () => {
    const parsed = parseStructuredOutput(CODEX_EVENTS);
    expect(parsed.ok).toBe(true);
    const events = parsed.value as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "thread.started",
      "item.completed",
      "turn.completed",
    ]);
  });

  test("NDJSON interleaved with non-JSON log lines", () => {
    const output = [
      "[INFO] session starting",
      '{"type":"say","text":"hello","ts":1760501486669}',
      "reconnecting... 1/3",
      '{"type":"say","text":"done","ts":1760501487999}',
    ].join("\n");
    const parsed = parseStructuredOutput(output);
    expect(parsed.ok).toBe(true);
    expect((parsed.value as unknown[]).length).toBe(2);
  });

  test("pretty-printed document embedded in banner noise (span recovery)", () => {
    const output = [
      "[INFO] launching headless run",
      "{",
      '  "conversation_id": "055a398f",',
      '  "status": "SUCCESS",',
      '  "response": "ok"',
      "}",
      "[INFO] exiting",
    ].join("\n");
    const parsed = parseStructuredOutput(output);
    expect(parsed.ok).toBe(true);
    expect((parsed.value as { status: string }).status).toBe("SUCCESS");
  });

  test("single-line JSON prefixed by log text", () => {
    const parsed = parseStructuredOutput('run finished: {"ok":true,"exit":0}');
    expect(parsed.ok).toBe(true);
    expect((parsed.value as { ok: boolean }).ok).toBe(true);
  });

  test("ANSI-styled JSON is stripped before parsing", () => {
    const styled = `\u001b[32m{"type":"say","text":"styled"}\u001b[0m`;
    const parsed = parseStructuredOutput(styled);
    expect(parsed.ok).toBe(true);
    expect((parsed.value as { text: string }).text).toBe("styled");
  });

  test("empty stdout fails with a reason", () => {
    const parsed = parseStructuredOutput("");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no stdout");
  });

  test("whitespace-only stdout fails with a reason", () => {
    const parsed = parseStructuredOutput("\n  \r\n");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no stdout");
  });

  test("plain-text output without JSON fails", () => {
    const parsed = parseStructuredOutput("compiled 42 files\nall checks passed\n");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no JSON");
  });

  test("truncated single object fails closed", () => {
    const parsed = parseStructuredOutput('{"type":"result","result":"partial va');
    expect(parsed.ok).toBe(false);
    expect(parsed.value).toBeUndefined();
    expect(parsed.error).toBeDefined();
  });

  test("truncated NDJSON stream fails closed (no partial payloads)", () => {
    const parsed = parseStructuredOutput(`${CODEX_EVENTS}\n{"type":"turn.failed","err`);
    expect(parsed.ok).toBe(false);
    expect(parsed.value).toBeUndefined();
    expect(parsed.error).toContain("truncated");
  });

  test("corrupt line between valid NDJSON lines fails closed", () => {
    const parsed = parseStructuredOutput(
      ['{"i":1}', '{"i":2 oops}', '{"i":3}'].join("\n"),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("line 2");
  });
});

describe("structured output capability", () => {
  test("all built-in harnesses declare support", () => {
    for (const harness of listHarnesses()) {
      expect(harness.supportsStructuredOutput).toBe(true);
    }
  });

  test("fails closed for a harness without the capability", () => {
    const harness = harnessWithoutCapability();
    expect(() => assertStructuredOutputSupported(harness, { structuredOutput: true })).toThrow(
      UnsupportedStructuredOutputError,
    );
    try {
      assertStructuredOutputSupported(harness, { structuredOutput: true });
    } catch (error) {
      const structuredError = error as UnsupportedStructuredOutputError;
      expect(structuredError.harnessName).toBe("test-text-only");
      expect(structuredError.message).toContain("Text Only (test-text-only)");
      expect(structuredError.message).toContain("structuredOutput");
    }
  });

  test("no-op when structured output is not requested (plain-text default)", () => {
    const harness = harnessWithoutCapability();
    expect(() => assertStructuredOutputSupported(harness, {})).not.toThrow();
    expect(() => assertStructuredOutputSupported(harness, { structuredOutput: false })).not.toThrow();
  });
});

describe("runner integration", () => {
  test(
    "Node runner parses a JSON envelope when requested",
    async () => {
      const result = await runAgentNode(
        emittingHarness(`printf '%s' '${CLAUDE_ENVELOPE}'`),
        "/bin/sh",
        "ignored",
        { silent: true, structuredOutput: true },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(CLAUDE_ENVELOPE);
      expect(expectStructuredPayload(result).ok).toBe(true);
      expect((expectStructuredPayload(result).value as { result: string }).result).toBe(
        "All tests pass.",
      );
    },
    10_000,
  );

  test(
    "Node runner parses NDJSON with interleaved logs when requested",
    async () => {
      const result = await runAgentNode(
        emittingHarness("printf 'booting\\n{\"i\":1}\\n{\"i\":2}\\n'"),
        "/bin/sh",
        "ignored",
        { silent: true, structuredOutput: true },
      );
      const structured = expectStructuredPayload(result);
      expect(structured.ok).toBe(true);
      expect(structured.value as unknown[]).toHaveLength(2);
    },
    10_000,
  );

  test(
    "Bun runner keeps stderr streaming working alongside structured parsing",
    async () => {
      const chunks: string[] = [];
      const result = await runAgentBun(
        emittingHarness("printf 'status line' >&2; printf '%s' '{\"done\":true}'"),
        "/bin/sh",
        "ignored",
        { silent: true, structuredOutput: true, onStderr: (chunk) => chunks.push(chunk) },
      );
      expect(chunks.join("")).toBe("status line");
      expect(result.stderr).toBe("status line");
      expect((expectStructuredPayload(result).value as { done: boolean }).done).toBe(true);
    },
    10_000,
  );

  test(
    "Node runner omits structured field by default (backward compatible)",
    async () => {
      const result = await runAgentNode(
        emittingHarness(`printf '%s' '${CLAUDE_ENVELOPE}'`),
        "/bin/sh",
        "ignored",
        { silent: true },
      );
      expect(result.structured).toBeUndefined();
      expect(result.stdout).toBe(CLAUDE_ENVELOPE);
    },
    10_000,
  );

  test(
    "Node runner reports malformed output without discarding stdout",
    async () => {
      const result = await runAgentNode(
        emittingHarness("printf '%s' '{\"truncated\":'"),
        "/bin/sh",
        "ignored",
        { silent: true, structuredOutput: true },
      );
      expect(result.exitCode).toBe(0);
      expect(result.structured?.ok).toBe(false);
      expect(result.structured?.error).toBeDefined();
      expect(result.stdout).toBe('{"truncated":');
    },
    10_000,
  );

  test(
    "Node runner fails closed before spawning when the harness lacks the capability",
    async () => {
      await expect(
        runAgentNode(harnessWithoutCapability(), "/opt/definitely-missing/agent", "ignored", {
          silent: true,
          structuredOutput: true,
        }),
      ).rejects.toBeInstanceOf(UnsupportedStructuredOutputError);
    },
    10_000,
  );

  test(
    "Bun runner parses a JSON envelope when requested",
    async () => {
      const result = await runAgentBun(
        emittingHarness(`printf '%s' '${CLAUDE_ENVELOPE}'`),
        "/bin/sh",
        "ignored",
        { silent: true, structuredOutput: true },
      );
      expect(result.exitCode).toBe(0);
      expect(expectStructuredPayload(result).ok).toBe(true);
      expect((expectStructuredPayload(result).value as { result: string }).result).toBe(
        "All tests pass.",
      );
    },
    10_000,
  );

  test(
    "Bun runner reports truncated output as a failure",
    async () => {
      const result = await runAgentBun(
        // %b interprets the \n escapes inside the fixture argument.
        emittingHarness(`printf '%b' '${CODEX_EVENTS}\\n{"type":"turn.failed","err'`),
        "/bin/sh",
        "ignored",
        { silent: true, structuredOutput: true },
      );
      expect(result.structured?.ok).toBe(false);
      expect(result.structured?.error).toContain("truncated");
      // Raw streams remain available for diagnostics.
      expect(result.stdout).toContain("turn.completed");
    },
    10_000,
  );

  test(
    "Bun runner omits structured field by default",
    async () => {
      const result = await runAgentBun(
        emittingHarness(`printf '%s' '${CLAUDE_ENVELOPE}'`),
        "/bin/sh",
        "ignored",
        { silent: true },
      );
      expect(result.structured).toBeUndefined();
    },
    10_000,
  );

  test(
    "Bun runner fails closed before spawning when the harness lacks the capability",
    async () => {
      await expect(
        runAgentBun(harnessWithoutCapability(), "/opt/definitely-missing/agent", "ignored", {
          silent: true,
          structuredOutput: true,
        }),
      ).rejects.toBeInstanceOf(UnsupportedStructuredOutputError);
    },
    10_000,
  );
});
