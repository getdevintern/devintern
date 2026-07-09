import { describe, expect, test } from "bun:test";
import {
  extractLoginFromArgv,
  extractLoginProviderFromArgv,
  loginMethodLabel,
  parseOAuthProvider,
} from "../src/login-provider";

describe("parseOAuthProvider", () => {
  test("accepts github, google, and x", () => {
    expect(parseOAuthProvider("github")).toBe("github");
    expect(parseOAuthProvider("google")).toBe("google");
    expect(parseOAuthProvider("x")).toBe("x");
  });

  test("is case-insensitive", () => {
    expect(parseOAuthProvider("Google")).toBe("google");
    expect(parseOAuthProvider("X")).toBe("x");
  });

  test("maps twitter alias to x", () => {
    expect(parseOAuthProvider("twitter")).toBe("x");
  });

  test("throws when value is missing", () => {
    expect(() => parseOAuthProvider(undefined)).toThrow(/required/);
  });

  test("throws for unknown providers", () => {
    expect(() => parseOAuthProvider("facebook")).toThrow(/Unknown login provider/);
  });
});

describe("extractLoginFromArgv", () => {
  test("reads positional OAuth provider after login", () => {
    expect(extractLoginFromArgv(["devintern", "login", "google"])).toEqual({
      method: "google",
    });
  });

  test("reads --provider flag", () => {
    expect(extractLoginFromArgv(["devpm", "login", "--provider", "x"])).toEqual({ method: "x" });
  });

  test("reads email method and address", () => {
    expect(extractLoginFromArgv(["devintern", "login", "email"])).toEqual({ method: "email" });
    expect(extractLoginFromArgv(["devintern", "login", "you@company.com"])).toEqual({
      method: "email",
      email: "you@company.com",
    });
    expect(extractLoginFromArgv(["devpm", "login", "--email", "you@company.com"])).toEqual({
      method: "email",
      email: "you@company.com",
    });
  });

  test("returns null when method omitted", () => {
    expect(extractLoginFromArgv(["devintern", "login"])).toBeNull();
  });

  test("throws when --email has no address", () => {
    expect(() => extractLoginFromArgv(["devintern", "login", "--email"])).toThrow(/--email requires/);
  });
});

describe("extractLoginProviderFromArgv", () => {
  test("returns OAuth provider only", () => {
    expect(extractLoginProviderFromArgv(["devintern", "login", "google"])).toBe("google");
    expect(extractLoginProviderFromArgv(["devintern", "login", "email"])).toBeNull();
    expect(extractLoginProviderFromArgv(["devintern", "login", "you@co.com"])).toBeNull();
  });
});

describe("loginMethodLabel", () => {
  test("returns display names", () => {
    expect(loginMethodLabel("github")).toBe("GitHub");
    expect(loginMethodLabel("google")).toBe("Google");
    expect(loginMethodLabel("x")).toBe("X");
    expect(loginMethodLabel("email")).toBe("Email");
  });
});
