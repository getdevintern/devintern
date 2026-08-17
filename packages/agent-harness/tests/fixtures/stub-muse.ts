#!/usr/bin/env bun
/**
 * Stub Muse CLI for agent-harness integration tests.
 *
 * Usage: stub-muse.ts exec --json [flags] [prompt]
 * Emits JSONL events on stdout.
 */

const args = process.argv.slice(2);

function usage(): never {
  console.error("stub-muse: usage: stub-muse exec --json [--prompt-file PATH | PROMPT]");
  process.exit(2);
}

if (args[0] === "--version" || args[0] === "-V") {
  console.log("stub-muse 0.0.0-test");
  process.exit(0);
}

if (args[0] !== "exec") {
  usage();
}

let json = false;
let prompt = "";
let promptFile = "";
let emitStepLimit = false;
let exitCode = 0;

for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg === "--prompt-file") {
    promptFile = args[++i] ?? "";
    continue;
  }
  if (arg === "--emit-step-limit") {
    emitStepLimit = true;
    continue;
  }
  if (arg === "--exit-code") {
    exitCode = parseInt(args[++i] ?? "1", 10);
    continue;
  }
  if (!arg.startsWith("-") && !prompt) {
    prompt = arg;
  }
}

if (!json) {
  console.error("stub-muse: --json is required");
  process.exit(2);
}

if (promptFile) {
  prompt = await Bun.file(promptFile).text();
}

const emit = (obj: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

emit({ type: "session", id: "00000000-0000-4000-8000-000000000001" });
emit({ type: "assistant", text: "Starting task.\n" });

if (emitStepLimit || prompt === "__STEP_LIMIT__") {
  emit({ type: "step_limit_reached", message: "max-model-steps exhausted" });
  process.exit(1);
}

if (prompt.includes("unicode")) {
  emit({ type: "assistant", text: "Handled unicode: café 🎉\n" });
} else {
  emit({ type: "assistant", text: `Echo: ${prompt.slice(0, 200)}\n` });
}

emit({ type: "result", text: "Done.\n" });
process.exit(exitCode);
