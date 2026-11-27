import { afterEach, expect, test } from "bun:test";
import {
  NpmNotVisibleError,
  registryFetchPackument,
  waitForNpmVersion,
} from "../../helpers/npm-visibility";

const PACKAGE = "@getdevintern/code";

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
    elapsed: () => time - 1_000_000,
  };
}

/**
 * A fake npm registry serving the abbreviated package document. The new
 * version is listed once `visibleAfterMs` of fake time has passed; before
 * that the document only has the previous release.
 */
function fakeRegistry(clock: ReturnType<typeof fakeClock>, visibleAfterMs: number) {
  const requests: { path: string; accept: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, accept: request.headers.get("accept") });
      if (url.pathname !== "/@getdevintern%2fcode") return new Response("{}", { status: 404 });
      const published = clock.elapsed() >= visibleAfterMs;
      return Response.json({
        name: PACKAGE,
        "dist-tags": { latest: published ? "2.30.0" : "2.29.0" },
        versions: { "2.29.0": {}, ...(published ? { "2.30.0": {} } : {}) },
      });
    },
  });
  servers.push(server);
  return { fetchPackument: registryFetchPackument(server.url.origin), requests };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("waits with backoff until a fresh version is listed and logs how long it took", async () => {
  const clock = fakeClock();
  const registry = fakeRegistry(clock, 4 * 60_000);
  const logs: string[] = [];

  const result = await waitForNpmVersion({
    packageName: PACKAGE,
    spec: "2.30.0",
    fetchPackument: registry.fetchPackument,
    sleep: clock.sleep,
    now: clock.now,
    log: (line) => logs.push(line),
  });

  expect(result.version).toBe("2.30.0");
  // 10 s, 20 s, 40 s, then capped at 60 s: visible on the check after 4 minutes.
  expect(clock.sleeps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  expect(result.waitedMs).toBe(250_000);
  expect(result.attempts).toBe(7);
  expect(registry.requests[0]).toEqual({
    path: "/@getdevintern%2fcode",
    accept: "application/vnd.npm.install-v1+json",
  });
  expect(logs[0]).toContain("not listed yet (latest is 2.29.0)");
  expect(logs.at(-1)).toBe(`${PACKAGE}@2.30.0 is visible on npm after 4m 10s`);
});

test("an already visible version resolves without waiting", async () => {
  const clock = fakeClock();
  const registry = fakeRegistry(clock, 0);
  const logs: string[] = [];

  const result = await waitForNpmVersion({
    packageName: PACKAGE,
    spec: "2.30.0",
    fetchPackument: registry.fetchPackument,
    sleep: clock.sleep,
    now: clock.now,
    log: (line) => logs.push(line),
  });

  expect(result).toEqual({ version: "2.30.0", waitedMs: 0, attempts: 1 });
  expect(clock.sleeps).toEqual([]);
  expect(logs).toEqual([]);
});

test("gives up after the timeout with a not-visible-on-npm error", async () => {
  const clock = fakeClock();
  const registry = fakeRegistry(clock, Number.POSITIVE_INFINITY);

  const error = await waitForNpmVersion({
    packageName: PACKAGE,
    spec: "2.30.0",
    fetchPackument: registry.fetchPackument,
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(NpmNotVisibleError);
  expect((error as Error).message).toBe(
    `${PACKAGE}@2.30.0 is not visible on npm after 15 minutes; the publish may still be propagating`,
  );
  // The last pause is trimmed so the wait ends at the deadline, not past it.
  expect(clock.elapsed()).toBe(15 * 60_000);
});

test("registry errors while waiting are retried", async () => {
  const clock = fakeClock();
  let calls = 0;
  const logs: string[] = [];

  const result = await waitForNpmVersion({
    packageName: PACKAGE,
    spec: "2.30.0",
    fetchPackument: async () => {
      calls++;
      if (calls === 1) throw new Error("npm registry: HTTP 503 for @getdevintern/code");
      if (calls === 2) return undefined;
      return { distTags: { latest: "2.30.0" }, versions: new Set(["2.30.0"]) };
    },
    sleep: clock.sleep,
    now: clock.now,
    log: (line) => logs.push(line),
  });

  expect(result.version).toBe("2.30.0");
  expect(logs[0]).toContain("HTTP 503");
  expect(logs[1]).toContain("package not found");
});

test("a dist-tag resolves once and is not waited for", async () => {
  const clock = fakeClock();
  const registry = fakeRegistry(clock, 0);

  expect(
    await waitForNpmVersion({
      packageName: PACKAGE,
      spec: "latest",
      fetchPackument: registry.fetchPackument,
      sleep: clock.sleep,
      now: clock.now,
    }),
  ).toEqual({ version: "2.30.0", waitedMs: 0, attempts: 1 });

  await expect(
    waitForNpmVersion({
      packageName: PACKAGE,
      spec: "next",
      fetchPackument: registry.fetchPackument,
      sleep: clock.sleep,
      now: clock.now,
    }),
  ).rejects.toThrow('has no "next" dist-tag');
  expect(clock.sleeps).toEqual([]);
});
