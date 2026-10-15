import { expect, test } from "bun:test";
import { resolveGitHubConfig } from "../../helpers/github-config";

const forbiddenLookup = async (): Promise<string> => {
  throw new Error("Local credentials must not be read");
};

test("explicit credentials work in CI without reading local authentication", async () => {
  expect(
    await resolveGitHubConfig(
      { CI: "true", E2E_GITHUB_REPOSITORY: "org/fixture", E2E_GITHUB_TOKEN: "test-token" },
      forbiddenLookup,
    ),
  ).toEqual({ repository: "org/fixture", token: "test-token" });
});

test("local runs use gh authentication and the dedicated fixture repository", async () => {
  expect(await resolveGitHubConfig({}, async () => "local-token")).toEqual({
    repository: "getdevintern/devintern-e2e",
    token: "local-token",
  });
});

test("CI requires an explicit repository before looking up credentials", async () => {
  await expect(resolveGitHubConfig({ CI: "true" }, forbiddenLookup)).rejects.toThrow(
    "E2E_GITHUB_REPOSITORY",
  );
});

test("GitHub Actions never falls back to local credentials", async () => {
  await expect(
    resolveGitHubConfig(
      { GITHUB_ACTIONS: "true", E2E_GITHUB_REPOSITORY: "org/fixture" },
      forbiddenLookup,
    ),
  ).rejects.toThrow("E2E_GITHUB_TOKEN CI secret");
});

test("invalid repository configuration fails before reading credentials", async () => {
  await expect(
    resolveGitHubConfig({ E2E_GITHUB_REPOSITORY: "https://github.com/org/repo" }, forbiddenLookup),
  ).rejects.toThrow("E2E_GITHUB_REPOSITORY");
});
