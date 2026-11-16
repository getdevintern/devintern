import { describe, expect, mock, test } from "bun:test";
import { enableEnvProxy, findProxyVar, formatCliError } from "./proxy.js";
import type { EnvProxyState } from "./proxy.js";

const PROXY_URL = "http://alice:s3cr3t@proxy.corp.example:3128";

function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

describe("enableEnvProxy", () => {
  test("calls setup once on Node when a proxy var is set", () => {
    const setup = mock((_env?: NodeJS.ProcessEnv) => () => {});
    const env = { HTTPS_PROXY: PROXY_URL, NO_PROXY: "localhost" };
    const state = enableEnvProxy({ env, runtime: "node", setGlobalProxyFromEnv: setup });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]?.[0]).toBe(env);
    expect(state).toEqual({ status: "enabled", proxyVar: "HTTPS_PROXY" });
  });

  test.each(["https_proxy", "HTTP_PROXY", "http_proxy"])("detects %s", (name) => {
    const setup = mock(() => {});
    enableEnvProxy({ env: { [name]: PROXY_URL }, runtime: "node", setGlobalProxyFromEnv: setup });
    expect(setup).toHaveBeenCalledTimes(1);
  });

  test("does not call setup without a proxy var", () => {
    const setup = mock(() => {});
    const state = enableEnvProxy({
      env: { NO_PROXY: "*", HTTPS_PROXY: "  " },
      runtime: "node",
      setGlobalProxyFromEnv: setup,
    });
    expect(setup).not.toHaveBeenCalled();
    expect(state.status).toBe("no-proxy");
  });

  test("does not call setup when NODE_USE_ENV_PROXY is already set", () => {
    const setup = mock(() => {});
    const state = enableEnvProxy({
      env: { HTTPS_PROXY: PROXY_URL, NODE_USE_ENV_PROXY: "1" },
      runtime: "node",
      setGlobalProxyFromEnv: setup,
    });
    expect(setup).not.toHaveBeenCalled();
    expect(state.status).toBe("preconfigured");
  });

  test("does not call setup under Bun", () => {
    const setup = mock(() => {});
    const state = enableEnvProxy({
      env: { HTTPS_PROXY: PROXY_URL },
      runtime: "bun",
      setGlobalProxyFromEnv: setup,
    });
    expect(setup).not.toHaveBeenCalled();
    expect(state.status).toBe("bun");
  });

  test("tolerates a missing API", () => {
    const state = enableEnvProxy({
      env: { HTTPS_PROXY: PROXY_URL },
      runtime: "node",
      setGlobalProxyFromEnv: undefined,
    });
    expect(state).toEqual({ status: "unsupported", proxyVar: "HTTPS_PROXY" });
  });

  test("swallows setup errors without leaking the URL", () => {
    const state = enableEnvProxy({
      env: { HTTPS_PROXY: "not a url" },
      runtime: "node",
      setGlobalProxyFromEnv: () => {
        throw new Error("Invalid proxy URL: not a url");
      },
    });
    expect(state).toEqual({ status: "invalid", proxyVar: "HTTPS_PROXY" });
  });
});

describe("findProxyVar", () => {
  test("prefers HTTPS_PROXY", () => {
    expect(findProxyVar({ HTTP_PROXY: "a", HTTPS_PROXY: "b" })).toBe("HTTPS_PROXY");
    expect(findProxyVar({})).toBeUndefined();
  });
});

describe("formatCliError", () => {
  const noProxy: EnvProxyState = { status: "no-proxy" };
  const unsupported: EnvProxyState = { status: "unsupported", proxyVar: "HTTPS_PROXY" };
  const enabled: EnvProxyState = { status: "enabled", proxyVar: "HTTPS_PROXY" };

  test("renders the cause code of a fetch failure", () => {
    const out = formatCliError(fetchFailed({ code: "ECONNREFUSED" }), {
      env: {},
      proxyState: noProxy,
    });
    expect(out).toBe("fetch failed (cause: ECONNREFUSED)");
  });

  test("finds a fetch failure wrapped in another error's cause", () => {
    const wrapped = new Error("Failed to create issue", {
      cause: fetchFailed({ code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
    expect(formatCliError(wrapped, { env: {}, proxyState: noProxy })).toBe(
      "Failed to create issue (cause: UND_ERR_CONNECT_TIMEOUT)",
    );
  });

  test("uses AggregateError inner codes and plain messages", () => {
    const agg = new AggregateError([Object.assign(new Error("x"), { code: "ENETUNREACH" })]);
    expect(formatCliError(fetchFailed(agg), { env: {}, proxyState: noProxy })).toContain(
      "ENETUNREACH",
    );
    expect(
      formatCliError(fetchFailed(new Error("getaddrinfo ENOTFOUND x")), {
        env: {},
        proxyState: noProxy,
      }),
    ).toBe("fetch failed (cause: getaddrinfo ENOTFOUND x)");
  });

  test("leaves non-network errors unchanged", () => {
    const env = { HTTPS_PROXY: PROXY_URL };
    expect(formatCliError(new Error("Jira 400: bad field"), { env, proxyState: unsupported })).toBe(
      "Jira 400: bad field",
    );
  });

  test("adds the hint only when a proxy is set and setup did not run", () => {
    const env = { HTTPS_PROXY: PROXY_URL };
    const err = fetchFailed({ code: "ECONNREFUSED" });
    const hint = "this Node runtime is not using it";

    expect(formatCliError(err, { env, proxyState: unsupported })).toContain(hint);
    expect(formatCliError(err, { env, proxyState: unsupported })).toContain(
      "A proxy is configured (HTTPS_PROXY)",
    );
    expect(formatCliError(err, { env, proxyState: enabled })).not.toContain(hint);
    expect(
      formatCliError(err, {
        env,
        proxyState: { status: "preconfigured", proxyVar: "HTTPS_PROXY" },
      }),
    ).not.toContain(hint);
    expect(
      formatCliError(err, { env, proxyState: { status: "bun", proxyVar: "HTTPS_PROXY" } }),
    ).not.toContain(hint);
    expect(formatCliError(err, { env: {}, proxyState: noProxy })).not.toContain(hint);
  });

  test("never prints the proxy URL or its credentials", () => {
    const env = { HTTPS_PROXY: PROXY_URL, http_proxy: PROXY_URL };
    const errors = [
      fetchFailed({ code: "ECONNREFUSED" }),
      fetchFailed(new Error(`connect to ${PROXY_URL} failed`)),
      new Error(`proxy ${PROXY_URL} said no`, { cause: fetchFailed(undefined) }),
      fetchFailed(new Error("tunnel via http://bob:hunter2@other-proxy:8080 failed")),
    ];
    for (const err of errors) {
      for (const proxyState of [unsupported, enabled, noProxy]) {
        const out = formatCliError(err, { env, proxyState });
        expect(out).not.toContain(PROXY_URL);
        expect(out).not.toContain("alice");
        expect(out).not.toContain("s3cr3t");
        expect(out).not.toContain("hunter2");
      }
    }
  });

  test("formats non-Error values", () => {
    expect(formatCliError("boom", { env: {}, proxyState: noProxy })).toBe("boom");
  });
});

describe("engine import has no proxy side effect", () => {
  test("lib/engine does not import the proxy module", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { getModuleDir } = await import("./path.js");
    const dir = join(getModuleDir(import.meta.url), "..", "engine");
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = await readFile(join(dir, file), "utf8");
      expect(content).not.toMatch(/runtime\/proxy/);
    }
  });
});
