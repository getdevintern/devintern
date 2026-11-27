import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReuseForActiveProject,
  fillReusedSecrets,
  inspectProjectInitForRenderer,
  parseReusedSecretsRequest,
  probeWithReusedSecrets,
  updateTrackerCredentials,
  writeInitialProjectConfig,
} from "./init-credentials.ts";

const TOKEN = "jira-secret-token-123";

let root: string;
let projectDir: string;
let workspaceDir: string;
let envSnapshot: Record<string, string | undefined>;

beforeEach(async () => {
  // persistTrackerCredentials mutates process.env; restore it after each test.
  envSnapshot = { ...process.env };
  root = await mkdtemp(join(tmpdir(), "pm-desktop-init-credentials-"));
  projectDir = join(root, "app");
  workspaceDir = join(root, "workspace");
  await mkdir(projectDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
  await rm(root, { recursive: true, force: true });
});

const JIRA_SETTINGS = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "dev@acme.com",
  JIRA_DEFAULT_PROJECT_KEY: "ACME",
};

function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Register the project in the workspace, with its Jira token in `env/app.env`. */
async function writeWorkspaceSource(): Promise<void> {
  await mkdir(join(workspaceDir, "env"), { recursive: true });
  await writeFile(
    join(workspaceDir, "workspace.toml"),
    `[[repos]]\nname = "app"\npath = ${JSON.stringify(projectDir)}\nmanual_only = true\nenv_file = "env/app.env"\n`,
  );
  await writeFile(
    join(workspaceDir, "env", "app.env"),
    envText({ TASK_TRACKER: "jira", ...JIRA_SETTINGS, JIRA_API_TOKEN: TOKEN }),
  );
}

async function writeLegacySource(): Promise<void> {
  await mkdir(join(projectDir, ".devintern-code"), { recursive: true });
  await writeFile(
    join(projectDir, ".devintern-code", ".env"),
    envText({ TASK_TRACKER: "jira", ...JIRA_SETTINGS, JIRA_API_TOKEN: TOKEN }),
  );
}

const sources = [
  {
    name: "workspace",
    write: writeWorkspaceSource,
    label: 'DevIntern workspace (repo "app")',
  },
  {
    name: "legacy .devintern-code/.env",
    write: writeLegacySource,
    label: "@devintern/code configuration (.devintern-code/.env)",
  },
];

describe.each(sources)("reused credentials from the $name source", ({ write, label }) => {
  beforeEach(write);

  test("the inspect payload names the secret but carries no secret value", async () => {
    const payload = await inspectProjectInitForRenderer(projectDir);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(payload.reusableSource).toBe(label);
    expect(payload.reusableFromCode).toEqual({
      trackerId: "jira",
      values: JIRA_SETTINGS,
      secretKeys: ["JIRA_API_TOKEN"],
    });
  });

  test("probe fills the reused secret the user left blank", async () => {
    const seen: Record<string, string>[] = [];
    const result = await probeWithReusedSecrets(
      "jira",
      { ...JIRA_SETTINGS },
      { projectDir, source: "code" },
      async (_trackerId, env) => {
        seen.push(env);
      },
    );
    expect(result).toEqual({ ok: true });
    expect(seen[0]?.JIRA_API_TOKEN).toBe(TOKEN);
  });

  test("save writes the reused secret", async () => {
    await writeInitialProjectConfig({
      projectDir,
      trackerId: "jira",
      values: { ...JIRA_SETTINGS },
      overwrite: false,
      reuseFromCode: true,
    });
    const written = await readFile(join(projectDir, ".devintern-pm", ".env"), "utf8");
    expect(written).toContain(`JIRA_API_TOKEN=${TOKEN}`);
  });

  test("a secret the user typed wins over the reused one", async () => {
    const filled = await fillReusedSecrets(
      "jira",
      { ...JIRA_SETTINGS, JIRA_API_TOKEN: "typed" },
      { projectDir, source: "code" },
    );
    expect(filled.JIRA_API_TOKEN).toBe("typed");
  });

  test("declining reuse fills nothing", async () => {
    await expect(
      writeInitialProjectConfig({
        projectDir,
        trackerId: "jira",
        values: { ...JIRA_SETTINGS },
        overwrite: false,
        reuseFromCode: false,
      }),
    ).rejects.toThrow("JIRA_API_TOKEN");
  });

  test("an edited base URL gets no reused secret", async () => {
    const seen: Record<string, string>[] = [];
    const result = await probeWithReusedSecrets(
      "jira",
      { ...JIRA_SETTINGS, JIRA_BASE_URL: "https://attacker.example" },
      { projectDir, source: "code" },
      async (_trackerId, env) => {
        seen.push(env);
      },
    );
    expect(result).toEqual({ ok: true });
    expect(seen[0]?.JIRA_API_TOKEN).toBeUndefined();
    await expect(
      writeInitialProjectConfig({
        projectDir,
        trackerId: "jira",
        values: { ...JIRA_SETTINGS, JIRA_BASE_URL: "https://attacker.example" },
        overwrite: false,
        reuseFromCode: true,
      }),
    ).rejects.toThrow("JIRA_API_TOKEN");
  });

  test("a trailing slash on the same base URL still reuses the secret", async () => {
    const filled = await fillReusedSecrets(
      "jira",
      { ...JIRA_SETTINGS, JIRA_BASE_URL: `${JIRA_SETTINGS.JIRA_BASE_URL}/` },
      { projectDir, source: "code" },
    );
    expect(filled.JIRA_API_TOKEN).toBe(TOKEN);
  });

  test("a different tracker never gets the reused secret", async () => {
    const filled = await fillReusedSecrets(
      "linear",
      {},
      {
        projectDir,
        source: "code",
      },
    );
    expect(filled).toEqual({});
  });
});

describe("current .devintern-pm/.env secrets", () => {
  beforeEach(async () => {
    await mkdir(join(projectDir, ".devintern-pm"), { recursive: true });
    await writeFile(
      join(projectDir, ".devintern-pm", ".env"),
      envText({
        TASK_TRACKER: "jira",
        ...JIRA_SETTINGS,
        JIRA_API_TOKEN: TOKEN,
        LINEAR_API_KEY: "lin-secret",
        AGENT_HARNESS: "codex",
      }),
    );
  });

  test("currentEnv keeps settings and lists secrets by key only", async () => {
    const payload = await inspectProjectInitForRenderer(projectDir);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("lin-secret");
    expect(payload.currentEnv).toEqual({ TASK_TRACKER: "jira", ...JIRA_SETTINGS });
    expect(payload.currentSecretKeys.toSorted()).toEqual(["JIRA_API_TOKEN", "LINEAR_API_KEY"]);
  });

  test("probe and update keep the current secret when left blank", async () => {
    const seen: Record<string, string>[] = [];
    await probeWithReusedSecrets(
      "jira",
      { ...JIRA_SETTINGS },
      { projectDir, source: "project" },
      async (_trackerId, env) => {
        seen.push(env);
      },
    );
    expect(seen[0]?.JIRA_API_TOKEN).toBe(TOKEN);

    await updateTrackerCredentials(projectDir, "jira", {
      ...JIRA_SETTINGS,
      JIRA_EMAIL: "new@acme.com",
    });
    const written = await readFile(join(projectDir, ".devintern-pm", ".env"), "utf8");
    expect(written).toContain(`JIRA_API_TOKEN=${TOKEN}`);
    expect(written).toContain("JIRA_EMAIL=new@acme.com");
  });
});

describe("renderer values outside the tracker's wizard fields", () => {
  beforeEach(async () => {
    await mkdir(join(projectDir, ".devintern-pm"), { recursive: true });
    await writeFile(
      join(projectDir, ".devintern-pm", ".env"),
      envText({ TASK_TRACKER: "linear", LINEAR_API_KEY: "lin-secret" }),
    );
  });

  const injected = {
    LINEAR_API_URL: "https://attacker.example/graphql",
    TRELLO_API_BASE_URL: "https://attacker.example/trello",
    ASANA_API_BASE_URL: "https://attacker.example/asana",
    AGENT_CLI_PATH: "/tmp/evil",
  };

  test("update drops API host overrides and keeps the stored key", async () => {
    await updateTrackerCredentials(projectDir, "linear", {
      LINEAR_DEFAULT_TEAM_KEY: "T",
      ...injected,
    });
    const written = await readFile(join(projectDir, ".devintern-pm", ".env"), "utf8");
    expect(written).toContain("LINEAR_API_KEY=lin-secret");
    expect(written).toContain("LINEAR_DEFAULT_TEAM_KEY=T");
    expect(written).not.toContain("attacker.example");
    expect(written).not.toContain("AGENT_CLI_PATH");
    // Compare against the injected value: CI itself sets AGENT_CLI_PATH.
    for (const [key, value] of Object.entries(injected)) expect(process.env[key]).not.toBe(value);
  });

  test("probe and init never see keys outside the wizard fields", async () => {
    const seen: Record<string, string>[] = [];
    await probeWithReusedSecrets(
      "linear",
      { LINEAR_DEFAULT_TEAM_KEY: "T", ...injected },
      { projectDir, source: "project" },
      async (_trackerId, env) => {
        seen.push(env);
      },
    );
    expect(seen[0]?.LINEAR_API_KEY).toBe("lin-secret");
    for (const key of Object.keys(injected)) expect(seen[0]?.[key]).toBeUndefined();

    const noReuse = await fillReusedSecrets(
      "linear",
      { LINEAR_API_KEY: "k", ...injected },
      undefined,
    );
    expect(noReuse).toEqual({ LINEAR_API_KEY: "k" });
  });
});

describe("current .devintern-pm/.env secrets for a host-bound tracker", () => {
  beforeEach(async () => {
    await mkdir(join(projectDir, ".devintern-pm"), { recursive: true });
    await writeFile(
      join(projectDir, ".devintern-pm", ".env"),
      envText({ TASK_TRACKER: "gitlab", GITLAB_TOKEN: "gl-secret", GITLAB_PROJECT: "g/r" }),
    );
  });

  test("a blank GitLab URL matches the default host; another host gets nothing", async () => {
    const reuse = { projectDir, source: "project" as const };
    const same = await fillReusedSecrets(
      "gitlab",
      { GITLAB_BASE_URL: "https://gitlab.com", GITLAB_PROJECT: "g/r" },
      reuse,
    );
    expect(same.GITLAB_TOKEN).toBe("gl-secret");
    const other = await fillReusedSecrets(
      "gitlab",
      { GITLAB_BASE_URL: "https://attacker.example", GITLAB_PROJECT: "g/r" },
      reuse,
    );
    expect(other.GITLAB_TOKEN).toBeUndefined();
  });

  test("update with a new host and a blank token fails instead of moving the token", async () => {
    await expect(
      updateTrackerCredentials(projectDir, "gitlab", {
        GITLAB_BASE_URL: "https://attacker.example",
        GITLAB_PROJECT: "g/r",
      }),
    ).rejects.toThrow("GITLAB_TOKEN");
    const written = await readFile(join(projectDir, ".devintern-pm", ".env"), "utf8");
    expect(written).not.toContain("attacker.example");
  });
});

describe("assertReuseForActiveProject", () => {
  test("allows the open project and rejects any other folder", () => {
    expect(() => assertReuseForActiveProject("/repos/app/", "/repos/app")).not.toThrow();
    expect(() => assertReuseForActiveProject("/repos/other", "/repos/app")).toThrow(
      "only available for the open project",
    );
    expect(() => assertReuseForActiveProject("/repos/app", null)).toThrow();
  });
});

describe("parseReusedSecretsRequest", () => {
  test("accepts the two sources and rejects anything else", () => {
    expect(parseReusedSecretsRequest(undefined)).toBeUndefined();
    expect(parseReusedSecretsRequest({ projectDir: "/p", source: "code" })).toEqual({
      projectDir: "/p",
      source: "code",
    });
    expect(() => parseReusedSecretsRequest({ projectDir: "/p", source: "env" })).toThrow(
      "Invalid credential reuse request.",
    );
    expect(() => parseReusedSecretsRequest("code")).toThrow();
  });
});
