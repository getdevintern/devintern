/**
 * HTTP(S) proxy support for the devpm CLI on Node.
 *
 * Node's built-in `fetch` (undici) ignores `HTTPS_PROXY` / `HTTP_PROXY` /
 * `NO_PROXY` unless the process starts with `NODE_USE_ENV_PROXY=1` or
 * `--use-env-proxy`. Bun's `fetch` honors them out of the box. This module
 * turns on Node's built-in env-proxy support at CLI startup and turns opaque
 * `fetch failed` errors into something actionable.
 *
 * Only the CLI entry point (`index.ts`) calls {@link enableEnvProxy}. Nothing
 * here runs on import, so `@getdevintern/pm/engine` consumers (pm-desktop) are
 * unaffected.
 */

import http from "node:http";
import { inspect } from "node:util";

export type JsRuntime = "node" | "bun";

/** Shape of `http.setGlobalProxyFromEnv` (Node >= 25.4.0 / 24.14.0). */
export type SetGlobalProxyFromEnv = (env?: NodeJS.ProcessEnv) => unknown;

/** Proxy URL variables, in the order they're reported. */
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

export type ProxyVarName = (typeof PROXY_VARS)[number];

/**
 * Outcome of {@link enableEnvProxy}.
 *
 * - `no-proxy`: no proxy variable set at startup; nothing to do.
 * - `bun`: running under Bun, whose `fetch` already honors proxy variables.
 * - `preconfigured`: `NODE_USE_ENV_PROXY=1` is set, so Node handles it itself.
 * - `enabled`: `http.setGlobalProxyFromEnv` was called.
 * - `unsupported`: this Node has no `http.setGlobalProxyFromEnv`.
 * - `invalid`: Node rejected the proxy configuration (e.g. an unparsable URL).
 */
export type EnvProxyStatus =
  | "no-proxy"
  | "bun"
  | "preconfigured"
  | "enabled"
  | "unsupported"
  | "invalid";

export interface EnvProxyState {
  status: EnvProxyStatus;
  /** Runtime detected at startup, recorded for every status. */
  runtime: JsRuntime;
  /** Name (never the value) of the first proxy variable found. */
  proxyVar?: ProxyVarName;
}

export interface EnableEnvProxyOptions {
  env?: NodeJS.ProcessEnv;
  runtime?: JsRuntime;
  /**
   * Override for `http.setGlobalProxyFromEnv`. Pass `undefined` explicitly to
   * simulate a Node version without the API.
   */
  setGlobalProxyFromEnv?: SetGlobalProxyFromEnv | undefined;
}

/** Detect whether the process runs under Bun or Node. */
export function detectRuntime(): JsRuntime {
  return typeof process.versions.bun === "string" ? "bun" : "node";
}

/**
 * Return the name of the first non-empty proxy URL variable, if any.
 *
 * @param env - Environment to inspect.
 */
export function findProxyVar(env: NodeJS.ProcessEnv): ProxyVarName | undefined {
  return PROXY_VARS.find((name) => (env[name] ?? "").trim() !== "");
}

function defaultSetGlobalProxyFromEnv(): SetGlobalProxyFromEnv | undefined {
  const candidate = (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv;
  return typeof candidate === "function" ? (candidate as SetGlobalProxyFromEnv) : undefined;
}

let currentState: EnvProxyState = { status: "no-proxy", runtime: detectRuntime() };

/** State recorded by the last {@link enableEnvProxy} call (CLI runs only). */
export function getEnvProxyState(): EnvProxyState {
  return currentState;
}

/**
 * Enable Node's built-in proxy support for `fetch()` and `http(s).request`
 * when a proxy variable is set. `NO_PROXY` / `no_proxy` is honored by Node.
 *
 * Uses `http.setGlobalProxyFromEnv`, added in Node v25.4.0 and v24.14.0. The
 * Node docs state it enables built-in proxy support "for `fetch()` and
 * `http.request()`/`https.request()` at runtime, as an alternative to using
 * the `--use-env-proxy` flag or `NODE_USE_ENV_PROXY` environment variable".
 * On older Node it does nothing here; {@link formatCliError} shows a hint
 * instead. Never throws.
 *
 * @param options - Injected env, runtime, and proxy API (for tests).
 * @returns The resulting proxy state, also stored for {@link getEnvProxyState}.
 */
export function enableEnvProxy(options: EnableEnvProxyOptions = {}): EnvProxyState {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? detectRuntime();
  const proxyVar = findProxyVar(env);

  let state: EnvProxyState;
  if (!proxyVar) {
    state = { status: "no-proxy", runtime };
  } else if (runtime === "bun") {
    state = { status: "bun", runtime, proxyVar };
  } else if (env.NODE_USE_ENV_PROXY === "1") {
    // Node only enables env-proxy support for exactly "1"; other values
    // (e.g. "0") leave it off, so fall through to setGlobalProxyFromEnv.
    state = { status: "preconfigured", runtime, proxyVar };
  } else {
    const setup =
      "setGlobalProxyFromEnv" in options
        ? options.setGlobalProxyFromEnv
        : defaultSetGlobalProxyFromEnv();
    if (!setup) {
      state = { status: "unsupported", runtime, proxyVar };
    } else {
      try {
        setup(env);
        state = { status: "enabled", runtime, proxyVar };
      } catch {
        // e.g. ERR_PROXY_INVALID_CONFIG. Its message embeds the proxy URL, so
        // only the status is kept.
        state = { status: "invalid", runtime, proxyVar };
      }
    }
  }

  currentState = state;
  return state;
}

/** Read a string `code` property from an unknown value. */
function readCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/** True for undici's network-level `TypeError: fetch failed`. */
function isFetchFailed(value: Error): boolean {
  return /fetch failed/i.test(value.message);
}

/** Find a `fetch failed` error in the error or its `cause` chain. */
function findFetchFailure(error: unknown): Error | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (isFetchFailed(current)) return current;
    current = current.cause;
  }
  return undefined;
}

/** Describe the underlying cause of a `fetch failed` error (code preferred). */
function describeCause(cause: unknown): string | undefined {
  const code = readCode(cause);
  if (code) return code;
  // Happy-eyeballs connection failures surface as an AggregateError.
  if (cause instanceof AggregateError) {
    const inner = cause.errors.map(readCode).find(Boolean);
    if (inner) return inner;
  }
  const innerCode = cause instanceof Error ? readCode(cause.cause) : undefined;
  if (innerCode) return innerCode;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return undefined;
}

/**
 * Strip proxy variable values and any `user:pass@` URL credentials from text.
 *
 * @param text - Text that may mention a proxy URL.
 * @param env - Environment holding the proxy variables.
 */
function redactProxy(text: string, env: NodeJS.ProcessEnv): string {
  let result = text;
  for (const name of PROXY_VARS) {
    const value = (env[name] ?? "").trim();
    if (value) result = result.split(value).join(`<${name}>`);
  }
  return result.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1<redacted>@");
}

/** Message plus underlying cause, before any proxy hint. */
function describeError(error: unknown): { text: string; fetchFailed: boolean } {
  const base =
    error instanceof Error ? error.message : typeof error === "string" ? error : inspect(error);
  const failure = findFetchFailure(error);
  if (!failure) return { text: base, fetchFailed: false };
  const cause = describeCause(failure.cause);
  if (!cause || base.includes(cause)) return { text: base, fetchFailed: true };
  return { text: `${base} (cause: ${cause})`, fetchFailed: true };
}

export interface FormatCliErrorOptions {
  env?: NodeJS.ProcessEnv;
  /** Proxy state from startup; defaults to {@link getEnvProxyState}. */
  proxyState?: EnvProxyState;
}

/**
 * Format an error for the CLI's top-level `❌ Error:` line. Network-level
 * `fetch failed` errors get their underlying cause code (e.g. `ECONNREFUSED`)
 * and, when a proxy variable is set but Node is not using it, a hint (none on
 * Bun, whose `fetch` reads proxy variables per request). Proxy
 * URLs are never included.
 *
 * @param error - Thrown value.
 * @param options - Injected env and proxy state (for tests).
 * @returns Single- or multi-line message text.
 */
export function formatCliError(error: unknown, options: FormatCliErrorOptions = {}): string {
  const env = options.env ?? process.env;
  const state = options.proxyState ?? getEnvProxyState();
  const { text, fetchFailed } = describeError(error);

  let hint: string | undefined;
  if (fetchFailed) {
    if (state.status === "invalid" && state.proxyVar) {
      hint = `A proxy is configured (${state.proxyVar}) but Node rejected its URL; check the proxy variable's format.`;
    } else if (state.status === "unsupported" && state.proxyVar) {
      hint = `A proxy is configured (${state.proxyVar}) but this Node runtime is not using it; upgrade Node or run with NODE_USE_ENV_PROXY=1.`;
    } else if (state.status === "no-proxy" && state.runtime === "node") {
      // The variable appeared after startup (e.g. from .devintern-pm/.env).
      // Node reads proxy settings once at startup, so neither upgrading nor
      // NODE_USE_ENV_PROXY helps. Bun's fetch reads them per request: no hint.
      const lateVar = findProxyVar(env);
      if (lateVar) {
        hint = `A proxy variable (${lateVar}) was set after startup (e.g. in .devintern-pm/.env), so Node is not using it; set it in your shell instead.`;
      }
    }
  }

  const message = hint ? `${text}\n   ${hint}` : text;
  return redactProxy(message, env);
}
