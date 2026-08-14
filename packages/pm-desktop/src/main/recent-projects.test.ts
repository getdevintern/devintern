import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RECENT_PROJECTS,
  filterEligibleRecentProjects,
  isEligibleRecentProject,
  listRecentProjectDirs,
  normalizeRecentProjectDirs,
  recordRecentProjectDir,
  rememberRecentProject,
} from "./recent-projects.ts";
import { setUserDataDirForTests } from "./settings.ts";

async function makePmReadyProject(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(dir, ".devintern-pm"), { recursive: true });
  await writeFile(join(dir, ".devintern-pm", ".env"), "TASK_TRACKER=markdown\n");
  return dir;
}

describe("recent-projects", () => {
  let tempDir: string;

  afterEach(async () => {
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("normalizeRecentProjectDirs rejects non-arrays and non-string entries", () => {
    expect(normalizeRecentProjectDirs(undefined)).toBeUndefined();
    expect(normalizeRecentProjectDirs("oops")).toBeUndefined();
    expect(normalizeRecentProjectDirs({ path: "/tmp" })).toBeUndefined();
    expect(normalizeRecentProjectDirs(3)).toBeUndefined();
    expect(normalizeRecentProjectDirs(["/a", 1, null, "/b", { x: 1 }])).toEqual(["/a", "/b"]);
    expect(normalizeRecentProjectDirs([])).toEqual([]);
  });

  test("rememberRecentProject prepends, dedupes, and caps", () => {
    const dirs = Array.from({ length: MAX_RECENT_PROJECTS }, (_, i) => `/proj/${i}`);
    const next = rememberRecentProject(dirs, "/proj/3");
    expect(next[0]).toBe("/proj/3");
    expect(next.filter((d) => d === "/proj/3")).toHaveLength(1);
    expect(next).toHaveLength(MAX_RECENT_PROJECTS);

    const overflow = rememberRecentProject(next, "/proj/new");
    expect(overflow[0]).toBe("/proj/new");
    expect(overflow).toHaveLength(MAX_RECENT_PROJECTS);
    expect(overflow).not.toContain("/proj/9");
  });

  test("isEligibleRecentProject requires existing .git and .devintern-pm", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    const ready = await makePmReadyProject(tempDir, "ready");
    const gitOnly = join(tempDir, "git-only");
    await mkdir(join(gitOnly, ".git"), { recursive: true });
    await writeFile(join(gitOnly, ".git", "HEAD"), "ref: refs/heads/main\n");
    const pmOnly = join(tempDir, "pm-only");
    await mkdir(join(pmOnly, ".devintern-pm"), { recursive: true });
    const missing = join(tempDir, "missing");

    expect(isEligibleRecentProject(ready)).toBe(true);
    expect(isEligibleRecentProject(gitOnly)).toBe(false);
    expect(isEligibleRecentProject(pmOnly)).toBe(false);
    expect(isEligibleRecentProject(missing)).toBe(false);
  });

  test("filterEligibleRecentProjects drops ineligible and duplicate paths", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    const a = await makePmReadyProject(tempDir, "a");
    const b = await makePmReadyProject(tempDir, "b");
    const gitOnly = join(tempDir, "git-only");
    await mkdir(join(gitOnly, ".git"), { recursive: true });
    await writeFile(join(gitOnly, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(filterEligibleRecentProjects([a, gitOnly, a, b, join(tempDir, "gone")])).toEqual([a, b]);
  });

  test("listRecentProjectDirs seeds from lastProjectDir and filters without writing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    setUserDataDirForTests(tempDir);
    const ready = await makePmReadyProject(tempDir, "ready");
    const gone = join(tempDir, "gone");

    const { updateSettings, readSettings } = await import("./settings.ts");
    await updateSettings({
      lastProjectDir: ready,
      recentProjectDirs: [ready, gone],
    });

    expect(await listRecentProjectDirs()).toEqual([ready]);
    // Read-only: stale paths stay on disk until the next record write.
    expect((await readSettings()).recentProjectDirs).toEqual([ready, gone]);
  });

  test("listRecentProjectDirs tolerates corrupt recentProjectDirs JSON", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    setUserDataDirForTests(tempDir);
    const ready = await makePmReadyProject(tempDir, "ready");

    // Hand-edited settings: recentProjectDirs is an object, not an array.
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, "settings.json"),
      JSON.stringify({ lastProjectDir: ready, recentProjectDirs: { bad: true } }, null, 2),
      "utf8",
    );

    expect(await listRecentProjectDirs()).toEqual([ready]);
  });

  test("concurrent recordRecentProjectDir keeps both opens", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    setUserDataDirForTests(tempDir);
    const a = await makePmReadyProject(tempDir, "a");
    const b = await makePmReadyProject(tempDir, "b");

    await Promise.all([recordRecentProjectDir(a), recordRecentProjectDir(b)]);

    const listed = await listRecentProjectDirs();
    expect(listed).toHaveLength(2);
    expect(listed).toContain(a);
    expect(listed).toContain(b);
    // Last writer wins the head slot; both must still be present.
    expect(listed[0] === a || listed[0] === b).toBe(true);
  });

  test("recordRecentProjectDir ignores unfinished folders and updates order", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    setUserDataDirForTests(tempDir);
    const a = await makePmReadyProject(tempDir, "a");
    const b = await makePmReadyProject(tempDir, "b");
    const gitOnly = join(tempDir, "git-only");
    await mkdir(join(gitOnly, ".git"), { recursive: true });
    await writeFile(join(gitOnly, ".git", "HEAD"), "ref: refs/heads/main\n");

    await recordRecentProjectDir(gitOnly);
    expect(await listRecentProjectDirs()).toEqual([]);

    await recordRecentProjectDir(a);
    await recordRecentProjectDir(b);
    await recordRecentProjectDir(a);
    expect(await listRecentProjectDirs()).toEqual([a, b]);

    const { readSettings } = await import("./settings.ts");
    expect((await readSettings()).lastProjectDir).toBe(a);
  });

  test("recordRecentProjectDir drops stale paths before capping so live recents survive", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-recent-"));
    setUserDataDirForTests(tempDir);

    // Fill to MAX with a mix of live + missing dirs. Without filtering first,
    // recording a new live dir would evict the oldest live path while keeping
    // dead slots occupied.
    const live: string[] = [];
    for (let i = 0; i < MAX_RECENT_PROJECTS - 2; i++) {
      live.push(await makePmReadyProject(tempDir, `live-${i}`));
    }
    const firstLive = live[0];
    const oldestLive = live[live.length - 1];
    expect(firstLive).toBeDefined();
    expect(oldestLive).toBeDefined();
    if (firstLive === undefined || oldestLive === undefined) {
      throw new Error("expected live recent projects to be seeded");
    }

    const dead = Array.from({ length: 2 }, (_, i) => join(tempDir, `dead-${i}`));
    const stored = [...live, ...dead];
    expect(stored).toHaveLength(MAX_RECENT_PROJECTS);

    const { updateSettings, readSettings } = await import("./settings.ts");
    await updateSettings({
      recentProjectDirs: stored,
      lastProjectDir: firstLive,
    });

    const newest = await makePmReadyProject(tempDir, "newest");
    await recordRecentProjectDir(newest);

    const listed = await listRecentProjectDirs();
    const persisted = (await readSettings()).recentProjectDirs ?? [];

    expect(listed[0]).toBe(newest);
    expect(listed).toEqual(persisted);
    expect(listed).toHaveLength(live.length + 1);
    for (const dir of dead) {
      expect(listed).not.toContain(dir);
    }
    // Oldest live path must still be present (would be evicted if dead slots
    // were counted toward the cap before filtering).
    expect(listed).toContain(oldestLive);
    for (const dir of live) {
      expect(listed).toContain(dir);
    }
  });
});
