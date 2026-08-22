import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChainExhaustedError, HarnessFallbackCoordinator } from "../src/lib/harness-fallback";
import type { FallbackAttemptRecord } from "../src/lib/harness-fallback";
import { parseHarnessChain, resolveHarnessCandidates } from "../src/lib/harness-chain";
import type { HarnessCandidate } from "../src/lib/harness-chain";
import { AgentLaunchError, executableMissingError } from "../src/lib/harness-launch";

function buildCandidates(spec: string): HarnessCandidate[] {
  return resolveHarnessCandidates(parseHarnessChain(spec));
}

/** Coordinator with repository-state checks stubbed to "clean tree". */
function cleanTreeCoordinator(
  spec: string,
  snapshots: string[] = [],
): { coordinator: HarnessFallbackCoordinator; snapshotCalls: { count: number } } {
  const state = { count: 0 };
  const coordinator = new HarnessFallbackCoordinator(buildCandidates(spec), {
    cwd: "/tmp/opencode",
    snapshotRepoState: () => {
      const snapshot = snapshots[state.count] ?? "clean";
      state.count += 1;
      return snapshot;
    },
  });
  return { coordinator, snapshotCalls: state };
}

function launchError(classification: AgentLaunchError["classification"], message: string) {
  return new AgentLaunchError(message, {
    classification,
    stdout: "",
    stderr: message,
    exitCode: 1,
  });
}

describe("HarnessFallbackCoordinator", () => {
  let logged: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    logged = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("successful first candidate records success without switching", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex");
    const result = await coordinator.run("implementation", (candidate) =>
      Promise.resolve(`ran:${candidate.entry.canonical}`),
    );
    expect(result).toBe("ran:claude-code");
    expect(coordinator.switched).toBe(false);
    expect(coordinator.activeHarnessName).toBe("claude-code");
    expect(coordinator.attemptLog).toHaveLength(1);
    expect(coordinator.attemptLog[0]?.outcome).toBe("succeeded");
    expect(coordinator.provenanceNote()).toBeNull();
  });

  test("executable-missing advances to the next configured harness in order", async () => {
    const { coordinator } = cleanTreeCoordinator("codex,opencode,claude-code");
    const attempts: string[] = [];
    const result = await coordinator.run("implementation", async (candidate) => {
      attempts.push(candidate.entry.canonical);
      if (candidate.entry.canonical === "codex") {
        throw executableMissingError(
          "Codex CLI not found at: codex\nPlease install Codex or specify the correct path",
        );
      }
      return `ok:${candidate.entry.canonical}`;
    });

    expect(attempts).toEqual(["codex", "opencode"]);
    expect(result).toBe("ok:opencode");
    expect(coordinator.switched).toBe(true);
    expect(coordinator.activeHarnessName).toBe("opencode");

    const transition = logged.find((line) => line.includes("Falling back"));
    expect(transition).toContain("Opencode");
    const failureLine = logged.find((line) => line.includes("could not start"));
    expect(failureLine).toContain("Codex");
    expect(logged.some((line) => line.includes("Falling back"))).toBe(true);
  });

  test.each(["auth-failed", "spawn-failed", "exited-before-output"] as const)(
    "%s advances through the chain",
    async (classification) => {
      const { coordinator } = cleanTreeCoordinator("claude-code,codex");
      const result = await coordinator.run("feasibility", async (candidate) => {
        if (candidate.entry.canonical === "claude-code") {
          throw launchError(classification, `${classification} occurred`);
        }
        return candidate.entry.canonical;
      });
      expect(result).toBe("codex");
      expect(coordinator.attemptLog[0]?.outcome).toBe(classification);
    },
  );

  test("non-zero exit after meaningful output does not trigger fallback", async () => {
    const { coordinator, snapshotCalls } = cleanTreeCoordinator("claude-code,codex", [
      "clean",
      "clean",
    ]);
    await expect(
      coordinator.run("implementation", async () => {
        throw new Error("Agent exited with code 3"); // plain error: post-work failure
      }),
    ).rejects.toThrow("Agent exited with code 3");

    expect(coordinator.switched).toBe(false);
    // Baseline captured; no second candidate attempted.
    expect(snapshotCalls.count).toBeLessThanOrEqual(2);
    expect(coordinator.attemptLog.every((a) => a.outcome !== "succeeded")).toBe(true);
  });

  test("timeout-style errors propagate unchanged and do not advance", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex");
    await expect(
      coordinator.run("implementation", async () => {
        throw new Error("Claude Code timed out after 60 minutes");
      }),
    ).rejects.toThrow(/timed out/);
    expect(coordinator.switched).toBe(false);
  });

  test("usage-limit errors are deferred, never traversing the chain", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex");
    const usageLimit = new Error("Agent usage limit reached (resets 3pm)");
    usageLimit.name = "UsageLimitError";
    let codexTried = false;
    await expect(
      coordinator.run("implementation", async (candidate) => {
        if (candidate.entry.canonical === "codex") {
          codexTried = true;
        }
        throw usageLimit;
      }),
    ).rejects.toThrow(/usage limit/i);
    expect(codexTried).toBe(false);
    expect(coordinator.switched).toBe(false);
  });

  test("working-tree mutation during a failed attempt fails safely instead of switching", async () => {
    const coordinator = new HarnessFallbackCoordinator(buildCandidates("claude-code,codex"), {
      cwd: "/tmp/opencode",
      // First call = baseline before attempt; second = after failure.
      snapshotRepoState: (() => {
        let call = 0;
        return () => (call++ === 0 ? "clean" : " M src/index.ts\n");
      })(),
    });

    await expect(
      coordinator.run("implementation", async () => {
        throw executableMissingError("CLI vanished mid-run");
      }),
    ).rejects.toThrow(/modifying the working tree|duplicating changes/i);

    expect(coordinator.switched).toBe(false);
    expect(coordinator.attemptLog[0]?.outcome).toBe("repository-mutated");
  });

  test("unverifiable repository state fails safely rather than falling back", async () => {
    const coordinator = new HarnessFallbackCoordinator(buildCandidates("claude-code,codex"), {
      cwd: "/tmp/opencode",
      snapshotRepoState: () => null,
    });
    await expect(
      coordinator.run("implementation", async () => {
        throw executableMissingError("ENOENT");
      }),
    ).rejects.toThrow(/repository state could not be verified/i);
    expect(coordinator.switched).toBe(false);
  });

  test("chain exhaustion fails once with an aggregated sanitized summary", async () => {
    const { coordinator } = cleanTreeCoordinator("codex, opencode , codex ");
    let error: ChainExhaustedError | undefined;
    try {
      await coordinator.run("implementation", async (candidate) => {
        throw executableMissingError(`${candidate.resolved.harness.displayName} CLI not found`);
      });
    } catch (err) {
      error = err as ChainExhaustedError;
    }

    expect(error).toBeInstanceOf(ChainExhaustedError);
    expect(error?.message).toContain("All configured agent harnesses failed");
    expect(error?.message).toContain("codex:");
    expect(error?.message).toContain("opencode:");
    // Deduplicated: codex appears once despite two configured entries.
    expect(error?.attempts.filter((a) => a.canonical === "codex")).toHaveLength(1);
  });

  test("active candidate persists across stages within one task attempt", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex");
    const usedByStage: Record<string, string[]> = {};
    const track = (stage: string, canonical: string) => {
      (usedByStage[stage] ??= []).push(canonical);
    };

    await coordinator.run("feasibility", async (candidate) => {
      track("feasibility", candidate.entry.canonical);
      if (candidate.entry.canonical === "claude-code") {
        throw launchError("auth-failed", "Not logged in. Run claude login.");
      }
      return null;
    });
    await coordinator.run("estimation", async (candidate) => {
      track("estimation", candidate.entry.canonical);
      return null;
    });
    await coordinator.run("implementation", async (candidate) => {
      track("implementation", candidate.entry.canonical);
      return null;
    });

    // Feasibility tried the primary, failed pre-work, and succeeded on codex.
    expect(usedByStage.feasibility).toEqual(["claude-code", "codex"]);
    // Later stages start directly at the active harness.
    expect(usedByStage.estimation).toEqual(["codex"]);
    expect(usedByStage.implementation).toEqual(["codex"]);
  });

  test("fully exhausted feasibility chain makes later stages fail fast", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex");
    await expect(
      coordinator.run("feasibility", async (candidate) => {
        throw executableMissingError(`${candidate.entry.canonical} missing`);
      }),
    ).rejects.toBeInstanceOf(ChainExhaustedError);

    let implementationRan = false;
    await expect(
      coordinator.run("implementation", async () => {
        implementationRan = true;
        return null;
      }),
    ).rejects.toBeInstanceOf(ChainExhaustedError);
    expect(implementationRan).toBe(false);
  });

  test("stageDetail captures attempts, classifications, and selection", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex");
    await coordinator.run("feasibility", async (candidate) => {
      if (candidate.entry.canonical === "claude-code") {
        throw launchError("auth-failed", "invalid api key sk-secret-value-1234567890");
      }
      return null;
    });

    const detail = coordinator.stageDetail();
    expect(detail.configured).toEqual(["claude-code", "codex"]);
    expect(detail.selected).toBe("codex");
    expect(detail.fallbackUsed).toBe(true);
    const attempts = detail.attempts as Array<Record<string, unknown>>;
    expect(attempts[0]?.harness).toBe("claude-code");
    expect(attempts[0]?.outcome).toBe("auth-failed");
    // Sanitized: no credential material persisted into stage detail.
    expect(JSON.stringify(detail)).not.toContain("sk-secret-value");
  });

  test("provenance note identifies superseded primary and selected harness", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code,codex,opencode");
    await coordinator.run("implementation", async (candidate) => {
      if (candidate.entry.canonical !== "codex") {
        throw executableMissingError(`${candidate.entry.canonical} not installed`);
      }
      return null;
    });
    const note = coordinator.provenanceNote();
    expect(note).toContain('"claude-code"');
    expect(note).toContain('"codex"');
    expect(note).toContain("AGENT_HARNESS fallback");
  });
});

describe("single-candidate regression behavior", () => {
  test("eligible failures surface directly when there is nothing to fall back to", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code");
    await expect(
      coordinator.run("implementation", async () => {
        throw executableMissingError("Claude Code CLI not found");
      }),
    ).rejects.toBeInstanceOf(ChainExhaustedError);
    expect(coordinator.switched).toBe(false);
  });

  test("plain errors keep their original message and type", async () => {
    const { coordinator } = cleanTreeCoordinator("claude-code");
    await expect(
      coordinator.run("feasibility", async () => {
        throw new Error("Clarity output unusable");
      }),
    ).rejects.toThrow("Clarity output unusable");
  });
});

describe("attempt record shape", () => {
  test("records carry stage, requested alias, canonical name, and reason", async () => {
    const { coordinator } = cleanTreeCoordinator("agy,codex");
    await coordinator.run("feasibility", async (candidate) => {
      if (candidate.entry.canonical === "antigravity") {
        throw executableMissingError("agy CLI not found on PATH");
      }
      return null;
    });
    const first = coordinator.attemptLog[0] as FallbackAttemptRecord;
    expect(first.stage).toBe("feasibility");
    expect(first.requested).toBe("agy");
    expect(first.canonical).toBe("antigravity");
    expect(first.outcome).toBe("executable-missing");
    expect(first.detail).toContain("agy CLI not found");
  });
});
