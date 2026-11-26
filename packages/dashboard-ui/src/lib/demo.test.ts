import { expect, test } from "bun:test";

import { createDemoFetch, DEMO_READ_ONLY_MESSAGE } from "@/lib/demo";

const ORIGIN = "https://devintern.test";
const BASE = `${ORIGIN}/demo/`;
const EXPORTED_AT = 1_795_000_000_000;
const LOADED_AT = EXPORTED_AT + 60_000;

/** A static host serving `files` (paths relative to BASE); records every request. */
function staticHost(files: Record<string, unknown>) {
  const requests: string[] = [];
  const hostFetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : String(input);
    requests.push(url);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    if (!(path in files)) return new Response("<!doctype html>", { status: 200 });
    const body = files[path];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { hostFetch, requests };
}

function demoFetch(files: Record<string, unknown>) {
  const host = staticHost({ "data/meta.json": { exportedAt: EXPORTED_AT }, ...files });
  const fetch = createDemoFetch({
    fetch: host.hostFetch,
    baseUrl: BASE,
    origin: ORIGIN,
    loadedAt: LOADED_AT,
  });
  return { fetch, requests: host.requests };
}

test("answers API GETs from the recording, shifted to the viewer's load time", async () => {
  const { fetch, requests } = demoFetch({
    "data/api/worker.json": { worker: { status: "running", heartbeatAt: EXPORTED_AT } },
  });
  const response = await fetch("/api/worker");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    worker: { status: "running", heartbeatAt: LOADED_AT },
  });
  expect(requests).toContain(`${BASE}data/api/worker.json`);
});

test("refuses every write without touching the network", async () => {
  const { fetch, requests } = demoFetch({});
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await fetch("/api/tasks", { method, body: "{}" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: DEMO_READ_ONLY_MESSAGE });
  }
  expect(requests).toEqual([]);
});

test("filters the run list from the full recording", async () => {
  const runs = [
    { id: 2, origin: "task", status: "failed", startedAt: EXPORTED_AT, taskKey: "A-2" },
    { id: 1, origin: "task", status: "succeeded", startedAt: EXPORTED_AT, taskKey: "A-1" },
  ];
  const { fetch } = demoFetch({ "data/api/runs.all.json": { runs, total: 2 } });
  const body = (await (await fetch("/api/runs?status=failed&limit=50")).json()) as {
    runs: { id: number; startedAt: number }[];
    total: number;
  };
  expect(body.total).toBe(1);
  expect(body.runs.map((r) => r.id)).toEqual([2]);
  expect(body.runs[0]?.startedAt).toBe(LOADED_AT);
});

test("reports unrecorded endpoints as 404 even behind an SPA fallback", async () => {
  const { fetch } = demoFetch({});
  const response = await fetch("/api/runs/999");
  expect(response.status).toBe(404);
});

test("passes non-API and cross-origin requests through", async () => {
  const { fetch, requests } = demoFetch({});
  await fetch(`${BASE}assets/app.css`);
  await fetch("https://elsewhere.test/api/overview");
  expect(requests).toEqual([`${BASE}assets/app.css`, "https://elsewhere.test/api/overview"]);
});

test("serves the notification inbox from fixtures around the recorded runs", async () => {
  const { fetch } = demoFetch({
    "data/api/runs.all.json": {
      runs: [
        {
          id: 41,
          origin: "scheduled",
          automationId: "docs-drift",
          status: "succeeded",
          startedAt: EXPORTED_AT,
        },
      ],
    },
  });
  const counts = (await (await fetch("/api/notifications/unread-count")).json()) as {
    unread: number;
    unreadHigh: number;
  };
  expect(counts.unreadHigh).toBeGreaterThan(0);
  const list = (await (await fetch("/api/notifications?limit=50")).json()) as {
    notifications: Array<{ kind: string; runId?: number; updatedAt: number }>;
  };
  const spawned = list.notifications.find((row) => row.kind === "work_spawned");
  expect(spawned?.runId).toBe(41);
  // Ages count back from the viewer's load time.
  expect(list.notifications.every((row) => row.updatedAt <= LOADED_AT)).toBe(true);
  const write = await fetch("/api/notifications/1/read", { method: "POST" });
  expect(write.status).toBe(403);
});
