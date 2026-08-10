import { describe, expect, test } from "bun:test";
import {
  canUpdateProjectFromRemote,
  projectGitSyncLabel,
  shouldShowUpdateFromRemote,
  type ProjectGitSyncStatus,
} from "./project-git-sync.ts";

describe("shouldShowUpdateFromRemote", () => {
  test("hides Update only when there is no remote", () => {
    expect(shouldShowUpdateFromRemote(undefined)).toBe(false);
    expect(
      shouldShowUpdateFromRemote({ kind: "no_remote", softDirty: false, message: "no remote" }),
    ).toBe(false);
    expect(
      shouldShowUpdateFromRemote({
        kind: "error",
        softDirty: false,
        message: "git fetch failed",
      }),
    ).toBe(true);
    expect(
      shouldShowUpdateFromRemote({
        kind: "behind",
        softDirty: true,
        behind: 1,
        message: "1 behind",
      }),
    ).toBe(true);
  });
});

describe("canUpdateProjectFromRemote", () => {
  test("allows Update for behind including soft-dirty", () => {
    expect(
      canUpdateProjectFromRemote({
        kind: "behind",
        softDirty: true,
        behind: 2,
        message: "2 behind",
      }),
    ).toBe(true);
    expect(
      canUpdateProjectFromRemote({
        kind: "behind",
        softDirty: false,
        behind: 2,
        message: "2 behind",
      }),
    ).toBe(true);
  });

  test("allows Update retry after transient sync error", () => {
    expect(
      canUpdateProjectFromRemote({
        kind: "error",
        softDirty: true,
        message: "git fetch failed: network unreachable",
      }),
    ).toBe(true);
  });

  test("allows Update retry after hard-dirty skip; blocks only no remote", () => {
    expect(
      canUpdateProjectFromRemote({
        kind: "skipped_dirty",
        softDirty: false,
        message: "local changes",
      }),
    ).toBe(true);
    expect(
      canUpdateProjectFromRemote({
        kind: "no_remote",
        softDirty: true,
        message: "no remote",
      }),
    ).toBe(false);
  });
});

describe("projectGitSyncLabel", () => {
  test("labels common kinds", () => {
    const behind: ProjectGitSyncStatus = {
      kind: "behind",
      softDirty: true,
      behind: 3,
      message: "x",
    };
    expect(projectGitSyncLabel(behind)).toBe("3 updates");
    expect(
      projectGitSyncLabel({
        kind: "skipped_dirty",
        softDirty: false,
        behind: 2,
        message: "x",
      }),
    ).toBe("2 updates · local edits");
    expect(projectGitSyncLabel({ kind: "skipped_dirty", softDirty: false, message: "x" })).toBe(
      "Local edits",
    );
    expect(projectGitSyncLabel({ kind: "no_remote", softDirty: false, message: "x" })).toBe(
      "Not linked online",
    );
    expect(projectGitSyncLabel({ kind: "error", softDirty: false, message: "x" })).toBe(
      "Couldn't get updates",
    );
  });

  test("does not surface soft-dirty .gitignore as Local edits", () => {
    expect(
      projectGitSyncLabel({
        kind: "ok",
        softDirty: true,
        message: "You're up to date.",
      }),
    ).toBeNull();
    expect(
      projectGitSyncLabel({
        kind: "ok",
        softDirty: true,
        updated: true,
        message: "Got latest changes (1 change).",
      }),
    ).toBe("Got updates");
  });
});
