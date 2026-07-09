const CALLBACK_TIMEOUT_MS = 180_000;
const EMAIL_CALLBACK_TIMEOUT_MS = 600_000;
const DEFAULT_SHUTDOWN_DELAY_MS = 250;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Styled HTML page shown in the browser after the OAuth/magic-link callback. */
function renderCallbackHtml(title: string, body: string, isError: boolean): string {
  const color = isError ? "#dc2626" : "#16a34a";
  const bgColor = isError ? "#fef2f2" : "#f0fdf4";
  const borderColor = isError ? "#fecaca" : "#bbf7d0";
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: #fff;
      border: 1px solid ${borderColor};
      border-radius: 0.75rem;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);
      max-width: 28rem;
      width: 100%;
      padding: 2rem;
      text-align: center;
    }
    .icon {
      width: 3rem;
      height: 3rem;
      border-radius: 50%;
      background: ${bgColor};
      color: ${color};
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1rem;
      font-size: 1.5rem;
      line-height: 1;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: ${color};
    }
    p {
      font-size: 0.95rem;
      line-height: 1.6;
      color: #475569;
      margin-bottom: 1rem;
    }
    .terminal {
      display: inline-block;
      background: #f1f5f9;
      border-radius: 0.375rem;
      padding: 0.25rem 0.5rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #334155;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isError ? "&#10007;" : "&#10003;"}</div>
    <h1>${safeTitle}</h1>
    <p>${safeBody}</p>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`;
}

export interface AuthCallbackServer {
  /** Redirect URL to pass to Supabase OAuth / magic-link options. */
  redirectTo: string;
  /**
   * Wait for the authorization code from the browser callback.
   *
   * @param timeoutMs - Max wait time in milliseconds (defaults to {@link AUTH_CALLBACK_TIMEOUT_MS}).
   * @returns PKCE authorization code from the callback query string.
   * @throws When the callback reports an OAuth error, omits the code, or times out.
   */
  waitForCode: (timeoutMs?: number) => Promise<string>;
  /**
   * Shut down the local callback HTTP server.
   *
   * Waits a short grace period so the browser can receive the HTML response
   * before force-closing open connections.
   *
   * @param delayMs - Time to wait before stopping the server (defaults to 250ms).
   */
  stop: (delayMs?: number) => Promise<void>;
}

/**
 * Local HTTP server that receives the Supabase PKCE callback (`?code=...`).
 *
 * @returns Callback server with redirect URL, code waiter, and shutdown hook.
 */
export function createAuthCallbackServer(): AuthCallbackServer {
  let codePromiseResolve: ((code: string) => void) | null = null;
  let codePromiseReject: ((reason?: unknown) => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  const authCodePromise = new Promise<string>((resolve, reject) => {
    codePromiseResolve = resolve;
    codePromiseReject = reject;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== "/auth/callback") {
        return new Response("Not Found", { status: 404 });
      }

      const errorDescription = url.searchParams.get("error_description");
      const oauthError = url.searchParams.get("error");
      if (oauthError || errorDescription) {
        const reason = errorDescription || oauthError || "Authentication failed";
        codePromiseReject?.(new Error(reason));
        return new Response(renderCallbackHtml("Authentication failed", `Error: ${reason}`, true), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const code = url.searchParams.get("code");
      if (!code) {
        codePromiseReject?.(new Error("Missing authorization code in callback URL."));
        return new Response(
          renderCallbackHtml("Authentication failed", "Missing authorization code.", true),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      codePromiseResolve?.(code);
      return new Response(
        renderCallbackHtml("Authentication successful", "Login completed.", false),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });

  const redirectTo = `http://127.0.0.1:${server.port}/auth/callback`;

  return {
    redirectTo,
    waitForCode(timeoutMs = CALLBACK_TIMEOUT_MS) {
      return Promise.race([
        authCodePromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for sign-in callback.")), timeoutMs),
        ),
      ]);
    },
    stop(delayMs = DEFAULT_SHUTDOWN_DELAY_MS) {
      if (stopPromise) return stopPromise;
      stopPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            server.stop(true);
          } catch {
            // ignore
          }
          resolve();
        }, delayMs);
      });
      return stopPromise;
    },
  };
}

/** Default OAuth callback wait time (3 minutes). */
export const AUTH_CALLBACK_TIMEOUT_MS = CALLBACK_TIMEOUT_MS;
/** Magic-link callback wait time (10 minutes). */
export const EMAIL_AUTH_CALLBACK_TIMEOUT_MS = EMAIL_CALLBACK_TIMEOUT_MS;
