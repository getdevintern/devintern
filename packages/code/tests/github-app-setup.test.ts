import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  hasGitHubAppCredentials,
  loadGitHubAppRecord,
  saveGitHubAppRecord,
} from "../src/lib/github-app-setup";

describe("github-app-setup", () => {
  let tempDir: string;
  const savedAppEnv = {
    appId: process.env.GITHUB_APP_ID,
    keyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
    keyBase64: process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-github-app-setup-"));
    mkdirSync(path.join(tempDir, ".devintern-code"), { recursive: true });
  });

  afterEach(() => {
    if (savedAppEnv.appId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = savedAppEnv.appId;
    if (savedAppEnv.keyPath === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    else process.env.GITHUB_APP_PRIVATE_KEY_PATH = savedAppEnv.keyPath;
    if (savedAppEnv.keyBase64 === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
    else process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = savedAppEnv.keyBase64;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("saves and reloads an enabled pairing record", () => {
    saveGitHubAppRecord(
      { repo: "acme/web", enabled: true, connectedAt: "2026-08-01T00:00:00.000Z" },
      tempDir,
    );
    const record = loadGitHubAppRecord(tempDir);
    expect(record?.repo).toBe("acme/web");
    expect(record?.enabled).toBe(true);
    expect(record?.connectedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(record?.recordedAt).toBeTruthy();
  });

  test("returns null when missing, malformed, or shape-invalid", () => {
    expect(loadGitHubAppRecord(tempDir)).toBeNull();
    writeFileSync(path.join(tempDir, ".devintern-code", "github-app.json"), "{not json", "utf8");
    expect(loadGitHubAppRecord(tempDir)).toBeNull();
    writeFileSync(
      path.join(tempDir, ".devintern-code", "github-app.json"),
      '{"enabled":true}',
      "utf8",
    );
    expect(loadGitHubAppRecord(tempDir)).toBeNull();
  });

  test("disabled records survive a round-trip", () => {
    saveGitHubAppRecord({ repo: "acme/web", enabled: false }, tempDir);
    expect(loadGitHubAppRecord(tempDir)?.enabled).toBe(false);
  });

  test("credentials require GITHUB_APP_ID plus one private key source", () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    delete process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
    expect(hasGitHubAppCredentials()).toBe(false);

    process.env.GITHUB_APP_ID = "123456";
    expect(hasGitHubAppCredentials()).toBe(false);

    process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = "LS0tLS1CRUdJTi4uLg==";
    expect(hasGitHubAppCredentials()).toBe(true);

    delete process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/tmp/app.private-key.pem";
    expect(hasGitHubAppCredentials()).toBe(true);
  });
});
