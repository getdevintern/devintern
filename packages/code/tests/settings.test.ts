import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import type { ProjectSettings } from "../src/types/settings";

// Test directory
const testDir = join("/tmp", "devintern-code-test-settings");
const settingsPath = join(testDir, ".devintern-code", "settings.json");

// Helper to create test settings
function createTestSettings(settings: ProjectSettings): void {
  const configDir = join(testDir, ".devintern-code");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

// Helper to load settings (simulating the function from index.ts)
function loadProjectSettings(baseDir: string): ProjectSettings | null {
  const settingsFilePath = join(baseDir, ".devintern-code", "settings.json");

  if (!existsSync(settingsFilePath)) {
    return null;
  }

  try {
    const settingsContent = Bun.file(settingsFilePath);
    return settingsContent.json() as ProjectSettings;
  } catch (error) {
    return null;
  }
}

// Replicated resolution logic from index.ts
function resolveProjectConfig(
  projectKey: string,
  settings: ProjectSettings | null,
  trackerType?: string,
) {
  if (!settings) {
    return undefined;
  }

  const tracker = trackerType ? trackerType.toLowerCase() : "jira";

  // 1. Check tracker-specific section first
  const trackerSection = settings[tracker as keyof ProjectSettings];
  if (trackerSection && typeof trackerSection === "object" && "projects" in trackerSection) {
    const projects = (trackerSection as import("../src/types/settings").TrackerSection).projects;
    if (projects) {
      const config = projects[projectKey];
      if (config) {
        return config;
      }

      if (tracker === "trello") {
        const defaultBoardId = process.env.TRELLO_DEFAULT_BOARD_ID;
        if (defaultBoardId && defaultBoardId !== projectKey && projects[defaultBoardId]) {
          return projects[defaultBoardId];
        }

        const projectKeys = Object.keys(projects);
        if (projectKeys.length === 1 && projectKeys[0]) {
          return projects[projectKeys[0]];
        }
      }
    }
  }

  // 2. Fall back to legacy top-level `projects` for Jira backward compatibility.
  if (tracker === "jira" && settings.projects) {
    return settings.projects[projectKey];
  }

  return undefined;
}

function getPrStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
  trackerType?: string,
): string | undefined {
  return resolveProjectConfig(projectKey, settings, trackerType)?.prStatus;
}

function getInProgressStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
  trackerType?: string,
): string | undefined {
  return resolveProjectConfig(projectKey, settings, trackerType)?.inProgressStatus;
}

describe("Project Settings", () => {
  beforeEach(() => {
    // Clean up before each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should load settings.json when it exists", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "In Review" },
        ABC: { prStatus: "Code Review" },
      },
    };

    createTestSettings(testSettings);

    const loaded = await loadProjectSettings(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.projects?.["PROJ"]?.prStatus).toBe("In Review");
    expect(loaded?.projects?.["ABC"]?.prStatus).toBe("Code Review");
  });

  test("should return null when settings.json does not exist", async () => {
    const loaded = await loadProjectSettings(testDir);
    expect(loaded).toBeNull();
  });

  test("should get PR status for configured project (legacy format)", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "In Review" },
        ABC: { prStatus: "Code Review" },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings)).toBe("In Review");
    expect(getPrStatusForProject("ABC", settings)).toBe("Code Review");
  });

  test("should return undefined for unconfigured project", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "In Review" },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("UNKNOWN", settings)).toBeUndefined();
  });

  test("should return undefined when settings is null", () => {
    expect(getPrStatusForProject("PROJ", null)).toBeUndefined();
  });

  test("should handle multiple projects with different statuses (legacy format)", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "In Review" },
        ABC: { prStatus: "Code Review" },
        XYZ: { prStatus: "Ready for QA" },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings)).toBe("In Review");
    expect(getPrStatusForProject("ABC", settings)).toBe("Code Review");
    expect(getPrStatusForProject("XYZ", settings)).toBe("Ready for QA");
  });

  test("should extract project key from task key", () => {
    const taskKey = "PROJ-123";
    const projectKey = taskKey.split("-")[0];
    expect(projectKey).toBe("PROJ");
  });

  test("should extract project key from different formats", () => {
    expect("ABC-456".split("-")[0]).toBe("ABC");
    expect("XYZ-789".split("-")[0]).toBe("XYZ");
    expect("LONG-PROJECT-123".split("-")[0]).toBe("LONG");
  });

  // ---- New multi-tracker tests ----

  test("should resolve Jira config from tracker-specific section", async () => {
    const testSettings: ProjectSettings = {
      jira: {
        projects: {
          PROJ: { prStatus: "In Review" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings, "jira")).toBe("In Review");
  });

  test("should resolve Linear config from tracker-specific section", async () => {
    const testSettings: ProjectSettings = {
      linear: {
        projects: {
          ENG: { prStatus: "In Review", inProgressStatus: "In Progress" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("ENG", settings, "linear")).toBe("In Review");
    expect(resolveProjectConfig("ENG", settings, "linear")?.inProgressStatus).toBe("In Progress");
  });

  test("should resolve Trello config from tracker-specific section", async () => {
    const testSettings: ProjectSettings = {
      trello: {
        projects: {
          BOARD: { prStatus: "Code Review" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("BOARD", settings, "trello")).toBe("Code Review");
  });

  test("should resolve Trello config when card board id differs from settings key", async () => {
    const previousDefaultBoardId = process.env.TRELLO_DEFAULT_BOARD_ID;
    process.env.TRELLO_DEFAULT_BOARD_ID = "abc123";

    try {
      const testSettings: ProjectSettings = {
        trello: {
          projects: {
            abc123: { inProgressStatus: "Doing", prStatus: "Review" },
          },
        },
      };

      createTestSettings(testSettings);
      const settings = await loadProjectSettings(testDir);

      expect(getInProgressStatusForProject("69febcac4e2e368657490ef3", settings, "trello")).toBe(
        "Doing",
      );
      expect(getPrStatusForProject("69febcac4e2e368657490ef3", settings, "trello")).toBe("Review");
    } finally {
      if (previousDefaultBoardId === undefined) {
        delete process.env.TRELLO_DEFAULT_BOARD_ID;
      } else {
        process.env.TRELLO_DEFAULT_BOARD_ID = previousDefaultBoardId;
      }
    }
  });

  test("should resolve GitHub config from tracker-specific section", async () => {
    const testSettings: ProjectSettings = {
      github: {
        projects: {
          REPO: { prStatus: "in review" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("REPO", settings, "github")).toBe("in review");
  });

  test("should resolve Azure DevOps config from tracker-specific section", async () => {
    const testSettings: ProjectSettings = {
      "azure-devops": {
        projects: {
          PROJ: { prStatus: "Resolved" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings, "azure-devops")).toBe("Resolved");
  });

  test("should resolve Asana config from tracker-specific section", async () => {
    const testSettings: ProjectSettings = {
      asana: {
        projects: {
          WORK: { prStatus: "In Review" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("WORK", settings, "asana")).toBe("In Review");
  });

  test("should not fall back to legacy projects for non-Jira trackers", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "Legacy Review" },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings, "linear")).toBeUndefined();
    expect(getPrStatusForProject("PROJ", settings, "trello")).toBeUndefined();
    expect(getPrStatusForProject("PROJ", settings, "github")).toBeUndefined();
  });

  test("should prefer tracker-specific section over legacy for Jira", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "Legacy Review" },
      },
      jira: {
        projects: {
          PROJ: { prStatus: "Jira Review" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings, "jira")).toBe("Jira Review");
  });

  test("should fall back to legacy projects for Jira when no jira section exists", async () => {
    const testSettings: ProjectSettings = {
      projects: {
        PROJ: { prStatus: "Legacy Review" },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(getPrStatusForProject("PROJ", settings, "jira")).toBe("Legacy Review");
  });

  test("should handle storyPointsField in tracker-specific sections", async () => {
    const testSettings: ProjectSettings = {
      jira: {
        projects: {
          PROJ: { storyPointsField: "customfield_10016" },
        },
      },
      linear: {
        projects: {
          ENG: { storyPointsField: "estimate" },
        },
      },
    };

    createTestSettings(testSettings);
    const settings = await loadProjectSettings(testDir);

    expect(resolveProjectConfig("PROJ", settings, "jira")?.storyPointsField).toBe(
      "customfield_10016",
    );
    expect(resolveProjectConfig("ENG", settings, "linear")?.storyPointsField).toBe("estimate");
  });
});
