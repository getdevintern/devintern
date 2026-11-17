/**
 * Loopback HTTP proxy that records which hosts a child process tried to reach
 * and refuses to forward anything, so tests can observe egress without any
 * traffic leaving the machine.
 *
 * Only the request line is parsed: the method and the target host. Headers and
 * bodies are never stored, because they can carry identifiers or credentials.
 */

import type { Socket } from "node:net";
import { createServer } from "node:net";

/** One refused request: the method and the target hostname (no port, no path). */
export interface ProxiedRequest {
  method: string;
  host: string;
}

export interface RecordingProxy {
  /** `http://127.0.0.1:<port>` for `HTTP(S)_PROXY`. */
  readonly url: string;
  /** Every request seen so far, in arrival order. */
  requests(): ProxiedRequest[];
  /** Requests whose target host equals `host` (case-insensitive). */
  requestsTo(host: string): ProxiedRequest[];
  /** Forget recorded requests, e.g. between two runs sharing one proxy. */
  reset(): void;
  /** Stop listening and destroy open client sockets. */
  close(): Promise<void>;
}

/** Longest request line accepted before the connection is dropped. */
const MAX_REQUEST_LINE_BYTES = 8 * 1024;

const REFUSAL = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/**
 * Extract the target host from a proxy request line: `CONNECT host:port` for
 * TLS tunnels, or an absolute URI (`GET http://host/path`) for plain HTTP.
 */
export function parseRequestLine(line: string): ProxiedRequest | null {
  const [method, target] = line.trim().split(/\s+/);
  if (!method || !target) return null;
  if (method.toUpperCase() === "CONNECT") {
    // `host:port`, or `[v6]:port`.
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(target);
    const host = bracketed ? bracketed[1] : target.replace(/:\d+$/, "");
    return host ? { method: "CONNECT", host: host.toLowerCase() } : null;
  }
  try {
    const url = new URL(target);
    return {
      method: method.toUpperCase(),
      host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    };
  } catch {
    // Origin-form request: not a proxy request, record nothing.
    return null;
  }
}

/** Start a refusing, recording proxy on an ephemeral loopback port. */
export async function startRecordingProxy(): Promise<RecordingProxy> {
  let recorded: ProxiedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n");
      if (end === -1) {
        if (buffered.length > MAX_REQUEST_LINE_BYTES) socket.destroy();
        return;
      }
      socket.off("data", onData);
      const request = parseRequestLine(buffered.slice(0, end));
      if (request) recorded.push(request);
      // Never tunnel or forward: refuse and close.
      socket.end(REFUSAL);
    };
    socket.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Recording proxy did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => [...recorded],
    requestsTo: (host) => recorded.filter((request) => request.host === host.toLowerCase()),
    reset: () => {
      recorded = [];
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Proxy variables (both cases) that route a child's HTTP(S) through `proxyUrl`,
 * bypassing only the listed loopback hosts.
 */
export function proxyEnvironment(
  proxyUrl: string,
  noProxy: readonly string[] = ["127.0.0.1", "localhost", "::1"],
): Record<string, string> {
  const bypass = noProxy.join(",");
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: bypass,
    no_proxy: bypass,
  };
}
