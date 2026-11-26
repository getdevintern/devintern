import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dashboardUrlFor } from "../src/lib/worker/service-report";

const BASE = `
[defaults]
tracker = "jira"

[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT AND status = Ready"
repo = "backend"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`;

let dir: string;
const savedPort = process.env.DASHBOARD_PORT;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "service-report-"));
  delete process.env.DASHBOARD_PORT;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedPort === undefined) delete process.env.DASHBOARD_PORT;
  else process.env.DASHBOARD_PORT = savedPort;
});

describe("dashboardUrlFor", () => {
  test("uses the default port when workspace.toml sets none", () => {
    writeFileSync(join(dir, "workspace.toml"), BASE);
    expect(dashboardUrlFor(dir)).toBe("http://localhost:4400");
  });

  test("uses dashboard_port from workspace.toml", () => {
    writeFileSync(join(dir, "workspace.toml"), `[workspace]\ndashboard_port = 4511\n${BASE}`);
    expect(dashboardUrlFor(dir)).toBe("http://localhost:4511");
  });

  test("follows DASHBOARD_PORT from the workspace .env", () => {
    writeFileSync(join(dir, "workspace.toml"), BASE);
    writeFileSync(join(dir, ".env"), "DASHBOARD_PORT=4622\n");
    expect(dashboardUrlFor(dir)).toBe("http://localhost:4622");
  });

  test("is null when the dashboard is off", () => {
    writeFileSync(join(dir, "workspace.toml"), `[workspace]\ndashboard = false\n${BASE}`);
    expect(dashboardUrlFor(dir)).toBeNull();
  });
});
