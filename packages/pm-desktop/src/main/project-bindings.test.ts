import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureUnmanagedBinding,
  findManagedBindingByRemote,
  rememberProjectBinding,
  removeProjectBinding,
  touchProjectBindingLastFetch,
  upsertProjectBinding,
} from "./project-bindings.ts";
import { setUserDataDirForTests } from "./settings.ts";

describe("project-bindings", () => {
  let tempDir: string;

  afterEach(async () => {
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("enforces one managed clone per remote", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-bindings-"));
    setUserDataDirForTests(tempDir);

    await rememberProjectBinding({
      id: "aaa",
      remote: "acme/web",
      localPath: join(tempDir, "web-a"),
      managed: true,
    });
    await upsertProjectBinding({
      id: "bbb",
      remote: "acme/web",
      localPath: join(tempDir, "web-b"),
      managed: true,
    });

    const found = await findManagedBindingByRemote("Acme/Web");
    expect(found?.id).toBe("bbb");
    expect(found?.localPath).toContain("web-b");
  });

  test("does not migrate unmanaged folder opens to managed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-bindings-"));
    setUserDataDirForTests(tempDir);

    const binding = await ensureUnmanagedBinding({
      localPath: join(tempDir, "existing"),
      remote: "acme/app",
    });
    expect(binding.managed).toBe(false);

    const again = await ensureUnmanagedBinding({
      localPath: join(tempDir, "existing"),
      remote: "acme/app",
    });
    expect(again.managed).toBe(false);
    expect(again.id).toBe(binding.id);
  });

  test("updates lastFetch and removes by id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-bindings-"));
    setUserDataDirForTests(tempDir);

    const path = join(tempDir, "repo");
    await rememberProjectBinding({
      id: "x",
      remote: "acme/r",
      localPath: path,
      managed: true,
    });
    await touchProjectBindingLastFetch(path, 12345);
    const found = await findManagedBindingByRemote("acme/r");
    expect(found?.lastFetch).toBe(12345);

    await removeProjectBinding("x");
    expect(await findManagedBindingByRemote("acme/r")).toBeNull();
  });
});
