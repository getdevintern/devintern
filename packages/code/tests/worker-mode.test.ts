import { describe, expect, test } from "bun:test";

import { resolveWorkerWorkspaceMode } from "../src/lib/worker-mode";

describe("resolveWorkerWorkspaceMode", () => {
  test("uses an explicitly requested workspace", () => {
    expect(
      resolveWorkerWorkspaceMode({
        workspaceRequested: true,
        noWorkspace: false,
        listen: false,
        workspaceExists: false,
      }),
    ).toEqual({ workspace: true });
  });

  test("auto-detects an existing workspace", () => {
    expect(
      resolveWorkerWorkspaceMode({
        workspaceRequested: false,
        noWorkspace: false,
        listen: false,
        workspaceExists: true,
      }),
    ).toEqual({ workspace: true });
  });

  test("keeps deprecated listen mode repo-local when a workspace is auto-detected", () => {
    expect(
      resolveWorkerWorkspaceMode({
        workspaceRequested: false,
        noWorkspace: false,
        listen: true,
        workspaceExists: true,
      }),
    ).toEqual({ workspace: false });
  });

  test("rejects an explicit workspace with deprecated listen mode", () => {
    expect(
      resolveWorkerWorkspaceMode({
        workspaceRequested: true,
        noWorkspace: false,
        listen: true,
        workspaceExists: true,
      }),
    ).toEqual({ workspace: false, conflict: "workspace-listen" });
  });
});
