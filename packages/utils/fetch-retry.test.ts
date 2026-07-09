import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry } from "./src/fetch-retry.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchWithRetry", () => {
  test("returns successful response on first attempt", async () => {
    globalThis.fetch = async () => new Response("ok", { status: 200 });

    const response = await fetchWithRetry("https://example.com/test");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("retries retryable HTTP status codes", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) {
        return new Response("busy", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    };

    const response = await fetchWithRetry(
      "https://example.com/retry",
      {},
      { maxRetries: 2, baseDelay: 1, jitter: false },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("does not retry non-retryable HTTP status codes", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response("bad request", { status: 400 });
    };

    const response = await fetchWithRetry("https://example.com/bad");
    expect(response.status).toBe(400);
    expect(attempts).toBe(1);
  });

  test("retries retryable network errors", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("socket hang up");
      }
      return new Response("ok", { status: 200 });
    };

    const response = await fetchWithRetry(
      "https://example.com/network",
      {},
      { maxRetries: 2, baseDelay: 1, jitter: false },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("throws immediately on non-retryable network errors", async () => {
    globalThis.fetch = async () => {
      throw new Error("invalid url format");
    };

    await expect(fetchWithRetry("https://example.com/fail")).rejects.toThrow("invalid url format");
  });

  test("does not log retry messages when verbose is false", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) {
        return new Response("busy", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    };

    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await fetchWithRetry(
        "https://example.com/retry",
        {},
        { maxRetries: 2, baseDelay: 1, jitter: false, verbose: false },
      );
      expect(logs).toEqual([]);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });

  test("logs retry messages when verbose is true", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) {
        return new Response("busy", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    };

    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await fetchWithRetry(
        "https://example.com/retry",
        {},
        { maxRetries: 2, baseDelay: 1, jitter: false, verbose: true },
      );
      expect(logs.some((l) => l.includes("HTTP 503"))).toBe(true);
      expect(logs.some((l) => l.includes("succeeded on attempt"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
});
