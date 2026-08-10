import { describe, expect, test } from "bun:test";
import { normalizeProjectBindings, toProjectBindingInfo } from "./project-binding.ts";

describe("normalizeProjectBindings", () => {
  test("returns undefined for non-arrays", () => {
    expect(normalizeProjectBindings(null)).toBeUndefined();
    expect(normalizeProjectBindings({})).toBeUndefined();
  });

  test("keeps valid bindings and drops corrupt entries", () => {
    const result = normalizeProjectBindings([
      {
        id: "abc",
        remote: "acme/web",
        localPath: "/tmp/web",
        managed: true,
        lastFetch: 100,
        branch: "main",
      },
      { id: "bad" },
      {
        id: "xyz",
        remote: null,
        localPath: "/tmp/other",
        managed: false,
      },
    ]);
    expect(result).toEqual([
      {
        id: "abc",
        remote: "acme/web",
        localPath: "/tmp/web",
        managed: true,
        lastFetch: 100,
        branch: "main",
      },
      {
        id: "xyz",
        remote: null,
        localPath: "/tmp/other",
        managed: false,
      },
    ]);
  });
});

describe("toProjectBindingInfo", () => {
  test("copies fields for the renderer", () => {
    expect(
      toProjectBindingInfo({
        id: "1",
        remote: "a/b",
        localPath: "/p",
        managed: true,
        lastFetch: 1,
      }),
    ).toEqual({
      id: "1",
      remote: "a/b",
      localPath: "/p",
      managed: true,
      lastFetch: 1,
    });
  });
});
