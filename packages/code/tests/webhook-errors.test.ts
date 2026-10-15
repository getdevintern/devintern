import { describe, expect, test } from "bun:test";

import { PermanentWebhookError, classifyWebhookError } from "../src/lib/webhook/webhook-errors";

describe("classifyWebhookError", () => {
  test("an explicit permanent error is permanent", () => {
    expect(classifyWebhookError(new PermanentWebhookError("issue was deleted"))).toBe("permanent");
    expect(
      classifyWebhookError(new PermanentWebhookError("issue was deleted", { status: 404 })),
    ).toBe("permanent");
  });

  test("terminal 4xx statuses are permanent", () => {
    for (const status of [400, 401, 404, 410, 422]) {
      // GitHub's client embeds the status in the message.
      expect(classifyWebhookError(new Error(`GitHub API error (${status}): nope`))).toBe(
        "permanent",
      );
      // Some clients attach it as a property.
      expect(classifyWebhookError(Object.assign(new Error("nope"), { status }))).toBe("permanent");
      expect(classifyWebhookError(Object.assign(new Error("nope"), { statusCode: status }))).toBe(
        "permanent",
      );
    }
  });

  test("ambiguous 403, 429 and 5xx statuses are transient", () => {
    for (const status of [403, 429, 500, 502, 503, 504]) {
      expect(classifyWebhookError(new Error(`HTTP ${status}`))).toBe("transient");
      expect(classifyWebhookError(Object.assign(new Error("nope"), { status }))).toBe("transient");
    }
  });

  test("403 rate limits remain retryable across client error formats", () => {
    for (const message of ["API rate limit exceeded", "secondary rate limit", "Forbidden"]) {
      expect(classifyWebhookError(new Error(`GitHub API error (403): ${message}`))).toBe(
        "transient",
      );
      expect(classifyWebhookError({ statusCode: 403, message })).toBe("transient");
      expect(classifyWebhookError({ response: { status: 403 }, message })).toBe("transient");
    }
    expect(
      classifyWebhookError(new PermanentWebhookError("permission denied", { status: 403 })),
    ).toBe("permanent");
  });

  test("network and unknown errors default to transient", () => {
    expect(classifyWebhookError(new Error("fetch failed"))).toBe("transient");
    expect(classifyWebhookError(new Error("socket hang up"))).toBe("transient");
    expect(classifyWebhookError("boom")).toBe("transient");
    expect(classifyWebhookError(undefined)).toBe("transient");
  });
});
