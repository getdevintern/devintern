import { describe, expect, test } from "bun:test";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { routeTask, ruleMatches, toRoutableTask } from "../src/lib/workspace/router";

const CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[repos]]
name = "infra"
remote = "git@github.com:acme/infra.git"

[[routing.rules]]
repo = "backend"
project = "BACK"

[[routing.rules]]
repo = "backend"
labels = ["backend"]

[[routing.rules]]
repo = "frontend"
project = "WEB"
components = ["ui", "design-system"]

[[routing.rules]]
repo = "infra"
labels = ["infra", "ops"]
`);

function task(key: string, labels: string[] = [], components: string[] = []) {
  return toRoutableTask({ key, labels, components });
}

describe("toRoutableTask", () => {
  test("derives the project key from PROJ-123 style keys", () => {
    expect(task("BACK-12").projectKey).toBe("BACK");
    expect(task("web_2-7").projectKey).toBe("web_2");
  });

  test("leaves the project key unset for numeric or opaque keys", () => {
    expect(task("123").projectKey).toBeUndefined();
    expect(task("64f1c9a2b3").projectKey).toBeUndefined();
    expect(task("task-list.md").projectKey).toBeUndefined();
  });
});

describe("ruleMatches", () => {
  test("ANDs set criteria and any-ofs list values, case-insensitively", () => {
    const rule = CONFIG.routing[2]; // frontend: project WEB + components ui/design-system
    expect(ruleMatches(task("WEB-1", [], ["UI"]), rule)).toBe(true);
    expect(ruleMatches(task("WEB-1", [], ["api"]), rule)).toBe(false);
    expect(ruleMatches(task("BACK-1", [], ["ui"]), rule)).toBe(false);
  });
});

describe("routeTask", () => {
  test("routes when exactly one repo matches", () => {
    const decision = routeTask(task("BACK-42"), CONFIG);
    expect(decision).toEqual({
      kind: "routed",
      repo: "backend",
      matchedRules: [CONFIG.routing[0]],
    });
  });

  test("multiple rules for the same repo still route", () => {
    const decision = routeTask(task("BACK-42", ["backend"]), CONFIG);
    expect(decision.kind).toBe("routed");
    if (decision.kind === "routed") {
      expect(decision.repo).toBe("backend");
      expect(decision.matchedRules).toHaveLength(2);
    }
  });

  test("rules pointing at different repos are ambiguous, never guessed", () => {
    const decision = routeTask(task("BACK-42", ["infra"]), CONFIG);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.candidates).toEqual(["backend", "infra"]);
    }
  });

  test("no matching rule leaves the task unrouted", () => {
    expect(routeTask(task("MISC-9"), CONFIG)).toEqual({ kind: "unrouted" });
  });

  test("label-only routing works for trackers without project keys", () => {
    const decision = routeTask(task("123", ["ops"]), CONFIG);
    expect(decision.kind).toBe("routed");
    if (decision.kind === "routed") {
      expect(decision.repo).toBe("infra");
    }
  });
});
