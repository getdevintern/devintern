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

describe("promptForLoginMethod", () => {
  // Regression test: readStdinLine once resolved "" for every entry because
  // rl.close() emitted "close" (and its resolve("")) before resolve(line) ran,
  // making the prompt reject all input. Exercise the real stdin path.
  async function runPrompt(fn: string, stdin: string): Promise<string> {
    const proc = Bun.spawn(
      ["bun", "-e", `import { ${fn} } from "./src/login-provider";
console.log("RESULT:" + JSON.stringify(await ${fn}()));`],
      { cwd: new URL("..", import.meta.url).pathname, stdin: "pipe", stdout: "pipe" },
    );
    proc.stdin.write(stdin);
    proc.stdin.end();
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const result = output.split("RESULT:")[1];
    if (!result) throw new Error(`No result in output:\n${output}`);
    return result.trim();
  }

  test("accepts a numeric choice from stdin", async () => {
    expect(JSON.parse(await runPrompt("promptForLoginMethod", "1\n"))).toEqual({
      method: "github",
    });
  });

  test("accepts a method name from stdin after an invalid entry", async () => {
    expect(JSON.parse(await runPrompt("promptForLoginMethod", "nope\ngoogle\n"))).toEqual({
      method: "google",
    });
  });

  test("promptForEmail accepts an address from stdin", async () => {
    expect(JSON.parse(await runPrompt("promptForEmail", "you@company.com\n"))).toBe(
      "you@company.com",
    );
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
