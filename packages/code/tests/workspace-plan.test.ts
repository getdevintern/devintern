import { describe, expect, test } from "bun:test";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { WorkspaceConfig } from "../src/lib/workspace/config";
import { buildPlanningPrompt, createMultiRepoPlanner } from "../src/lib/workspace/planner-agent";
import {
  coordinationBranchName,
  generateCoordinationId,
  parsePlanEntries,
  topologicalOrder,
  validateAndOrderPlan,
} from "../src/lib/workspace/plan";

const HINTS_CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "shared-config"
remote = "git@github.com:acme/shared-config.git"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
branch_prefix = "task"
  [repos.hints]
  purpose = "Core REST API service"
  domains = ["api", "auth"]
  capabilities = ["auth"]
  owned_paths = ["api/", "services/"]
  depends_on = ["shared-config"]

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
  [repos.hints]
  purpose = "Web dashboard"
  depends_on = ["backend"]

[[repos]]
name = "plain"
remote = "git@github.com:acme/plain.git"

[[routing.rules]]
repo = "backend"
project = "BACK"

[[routing.rules]]
repo = "frontend"
project = "WEB"
`);

describe("workspace routing hints (config schema)", () => {
  test("parses optional per-repo hints", () => {
    const backend = HINTS_CONFIG.repos.find((repo) => repo.name === "backend");
    expect(backend?.hints).toEqual({
      purpose: "Core REST API service",
      domains: ["api", "auth"],
      capabilities: ["auth"],
      ownedPaths: ["api/", "services/"],
      dependsOn: ["shared-config"],
    });
    expect(backend?.branchPrefix).toBe("task");
  });

  test("configs without hints stay valid and hints stay undefined", () => {
    const plain = HINTS_CONFIG.repos.find((repo) => repo.name === "plain");
    expect(plain?.hints).toBeUndefined();
    expect(plain?.branchPrefix).toBeUndefined();
  });

  test("depends_on must reference configured repos", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "a"
remote = "git@github.com:acme/a.git"
  [repos.hints]
  depends_on = ["missing"]
`),
    ).toThrow(/unknown repo "missing"/);
  });

  test("self-dependencies are rejected", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "a"
remote = "git@github.com:acme/a.git"
  [repos.hints]
  depends_on = ["a"]
`),
    ).toThrow(/lists itself/);
  });

  test("an empty [repos.hints] table is accepted as absent", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "a"
remote = "git@github.com:acme/a.git"
  [repos.hints]
`);
    expect(config.repos[0]?.hints).toBeUndefined();
  });
});

describe("coordination IDs and branch names", () => {
  test("IDs embed the task key and are unique across calls", () => {
    const first = generateCoordinationId("DEV-84");
    const second = generateCoordinationId("DEV-84");
    expect(first.startsWith("dev-84-")).toBe(true);
    expect(first).not.toBe(second);
    // Branch-safe characters only.
    expect(first).toMatch(/^[a-z0-9._-]+$/);
  });

  test("branch names derive deterministically from the coordination ID and repo convention", () => {
    const backend = HINTS_CONFIG.repos.find((repo) => repo.name === "backend");
    const plain = HINTS_CONFIG.repos.find((repo) => repo.name === "plain");
    if (!backend || !plain) throw new Error("test config missing repos");

    expect(coordinationBranchName(backend, "dev-84-abc")).toBe("task/dev-84-abc");
    expect(coordinationBranchName(plain, "dev-84-abc")).toBe("feature/dev-84-abc");
    // Deterministic across repeated calls.
    expect(coordinationBranchName(plain, "dev-84-abc")).toBe(
      coordinationBranchName(plain, "dev-84-abc"),
    );
  });
});

describe("plan validation", () => {
  const entry = (repo: string, dependencies: string[] = []) => ({
    repo,
    rationale: `because ${repo}`,
    change: `change ${repo}`,
    dependencies,
  });

  test("rejects an empty selection instead of guessing", () => {
    const result = validateAndOrderPlan([], HINTS_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/selected no repositories/i);
    }
  });

  test("rejects unknown repository references before any mutation", () => {
    const result = validateAndOrderPlan([entry("nope")], HINTS_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/not configured in the workspace/);
    }
  });

  test("rejects duplicate selections", () => {
    const result = validateAndOrderPlan([entry("backend"), entry("backend")], HINTS_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/more than once/);
    }
  });

  test("rejects dependencies on unselected repositories (fail safely)", () => {
    const result = validateAndOrderPlan([entry("backend", ["frontend"])], HINTS_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/was not selected/);
    }
  });

  test("rejects dependency cycles with a readable path", () => {
    const result = validateAndOrderPlan(
      [entry("backend", ["frontend"]), entry("frontend", ["backend"]), entry("shared-config")],
      HINTS_CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/[Cc]ycle detected/);
      expect(result.errors.join("\n")).toContain("->");
    }
  });

  test("computes a deterministic dependency-respecting execution order", () => {
    const result = validateAndOrderPlan(
      [entry("frontend", ["backend"]), entry("backend", ["shared-config"]), entry("shared-config")],
      HINTS_CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executionOrder).toEqual(["shared-config", "backend", "frontend"]);
    }
  });

  test("ties break alphabetically so identical plans order identically", () => {
    const entries = [entry("plain"), entry("backend"), entry("frontend")];
    const first = validateAndOrderPlan(entries, HINTS_CONFIG);
    const second = validateAndOrderPlan([...entries].reverse(), HINTS_CONFIG);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.executionOrder).toEqual(["backend", "frontend", "plain"]);
      expect(first.executionOrder).toEqual(second.executionOrder);
    }
  });
});

describe("topologicalOrder", () => {
  test("orders a diamond without changing independent nodes' relative order", () => {
    const result = topologicalOrder([
      { repo: "app", rationale: "", change: "", dependencies: ["lib-b", "lib-a"] },
      { repo: "lib-b", rationale: "", change: "", dependencies: [] },
      { repo: "lib-a", rationale: "", change: "", dependencies: [] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executionOrder).toEqual(["lib-a", "lib-b", "app"]);
    }
  });
});

describe("planner agent response parsing", () => {
  test("parses fenced JSON plans into normalized entries", () => {
    const output =
      'Here is my plan:\n```json\n{"repos":[{"repo":" backend ","rationale":"owns api","change":"add endpoint","dependencies":["shared-config"]}]}\n```\ndone';
    const entries = parsePlanEntries(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      repo: "backend",
      rationale: "owns api",
      change: "add endpoint",
      dependencies: ["shared-config"],
    });
  });

  test("throws on malformed or wrong-shaped responses", () => {
    expect(() => parsePlanEntries('{"plans": []}')).toThrow();
    expect(() => parsePlanEntries('{"repos": [{"change": "x"}]}')).toThrow(
      /must be a non-empty string/,
    );
    expect(() => parsePlanEntries("not json at all")).toThrow();
  });

  test("the planner fails safely when the agent returns nothing usable", async () => {
    const planner = createMultiRepoPlanner({
      config: HINTS_CONFIG,
      runAgent: async () => "I could not decide.",
    });
    const result = await planner({ taskKey: "DEV-1", candidates: ["backend"] });
    expect(result.ok).toBe(false);
  });

  test("the planner surfaces validation errors from over-eager selections", async () => {
    const planner = createMultiRepoPlanner({
      config: HINTS_CONFIG,
      runAgent: async () =>
        JSON.stringify({
          repos: [{ repo: "backend", dependencies: ["frontend"] }, { repo: "unknown-repo" }],
        }),
    });
    const result = await planner({ taskKey: "DEV-2", candidates: ["backend"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/not configured in the workspace/);
      expect(result.errors.join("\n")).toMatch(/was not selected/);
    }
  });

  test("the planner returns validated entries plus execution order", async () => {
    const planner = createMultiRepoPlanner({
      config: HINTS_CONFIG,
      runAgent: async (prompt) => {
        // The prompt must carry the routing hints for informed planning.
        expect(prompt).toContain("Core REST API service");
        expect(prompt).toContain("owned paths: api/");
        expect(prompt).toContain("depends on: shared-config");
        return JSON.stringify({
          repos: [
            { repo: "frontend", dependencies: ["backend"], rationale: "renders it" },
            { repo: "backend", dependencies: [], rationale: "implements api" },
          ],
        });
      },
    });
    const result = await planner({ taskKey: "DEV-3", candidates: ["backend", "frontend"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executionOrder).toEqual(["backend", "frontend"]);
    }
  });

  test("the planning prompt carries task context, candidates, hints, and output rules", () => {
    const prompt = buildPlanningPrompt(
      {
        taskKey: "DEV-4",
        title: "Split the flag service",
        description: "Move feature flags out of the API",
        candidates: ["backend", "frontend"],
      },
      HINTS_CONFIG,
    );
    expect(prompt).toContain("Key: DEV-4");
    expect(prompt).toContain("Title: Split the flag service");
    expect(prompt).toContain("candidates): backend, frontend");
    expect(prompt).toContain("- shared-config (no hints)");
    expect(prompt).toContain("capabilities provided: auth");
    // Strict output shape so parsePlanEntries can rely on it.
    expect(prompt).toContain('"repos"');
    expect(prompt).toMatch(/ONLY a JSON object/);
  });
});
