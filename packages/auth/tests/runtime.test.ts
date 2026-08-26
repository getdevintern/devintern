import { describe, expect, test } from "bun:test";
import { DEFAULT_REMOTE_AUTH_CALLBACK_PORT } from "../src/auth-callback";
import { isRemoteCliSession, resolveAuthCallbackPort } from "../src/runtime";

describe("isRemoteCliSession", () => {
  test("is false for a normal local env", () => {
    expect(isRemoteCliSession({})).toBe(false);
  });

  test("detects SSH and mosh markers", () => {
    expect(isRemoteCliSession({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" })).toBe(true);
    expect(isRemoteCliSession({ SSH_CLIENT: "1.2.3.4 1 22" })).toBe(true);
    expect(isRemoteCliSession({ SSH_TTY: "/dev/pts/0" })).toBe(true);
    expect(isRemoteCliSession({ MOSH: "1" })).toBe(true);
  });
});

describe("resolveAuthCallbackPort", () => {
  test("returns undefined locally without override", () => {
    expect(resolveAuthCallbackPort({}, false)).toBeUndefined();
  });

  test("uses the stable remote port when remote", () => {
    expect(resolveAuthCallbackPort({}, true)).toBe(DEFAULT_REMOTE_AUTH_CALLBACK_PORT);
  });

  test("honors DEVINTERN_AUTH_CALLBACK_PORT over remote default", () => {
    expect(resolveAuthCallbackPort({ DEVINTERN_AUTH_CALLBACK_PORT: "19000" }, true)).toBe(19000);
    expect(resolveAuthCallbackPort({ DEVINTERN_AUTH_CALLBACK_PORT: "19000" }, false)).toBe(19000);
  });

  test("rejects invalid override ports", () => {
    expect(() => resolveAuthCallbackPort({ DEVINTERN_AUTH_CALLBACK_PORT: "nope" })).toThrow(
      /DEVINTERN_AUTH_CALLBACK_PORT/,
    );
  });
});
