import { describe, expect, test } from "bun:test";
import { createAuthCallbackServer } from "../src/auth-callback";

describe("createAuthCallbackServer", () => {
  test("returns a valid redirect URL with localhost", async () => {
    const server = await createAuthCallbackServer();
    expect(server.redirectTo).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(server.port).toBeGreaterThan(0);
    await server.stop(0);
  });

  test("binds a fixed port when requested", async () => {
    const server = await createAuthCallbackServer({ port: 0 });
    // port 0 still means ephemeral; assert the exposed port matches the URL
    expect(server.redirectTo).toBe(`http://127.0.0.1:${server.port}/auth/callback`);
    await server.stop(0);

    const fixed = await createAuthCallbackServer({ port: 17866 });
    expect(fixed.port).toBe(17866);
    expect(fixed.redirectTo).toBe("http://127.0.0.1:17866/auth/callback");
    await fixed.stop(0);
  });

  test("returns 404 for non-callback paths", async () => {
    const server = await createAuthCallbackServer();
    const res = await fetch(`http://127.0.0.1:${new URL(server.redirectTo).port}/other`);
    expect(res.status).toBe(404);
    await server.stop(0);
  });

  test("resolves waitForCode on valid callback and returns styled success HTML", async () => {
    const server = await createAuthCallbackServer();
    const port = new URL(server.redirectTo).port;

    const waitPromise = server.waitForCode();

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=test-auth-code`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("Authentication successful");
    expect(html).toContain("Login completed");
    expect(html).toContain("&#10003;");

    const code = await waitPromise;
    expect(code).toBe("test-auth-code");
    await server.stop(0);
  });

  test("rejects waitForCode on OAuth error and returns styled error HTML", async () => {
    const server = await createAuthCallbackServer();
    const port = new URL(server.redirectTo).port;

    const waitPromise = server.waitForCode();
    waitPromise.catch(() => {}); // suppress unhandled rejection in test runner

    const res = await fetch(
      `http://127.0.0.1:${port}/auth/callback?error=access_denied&error_description=User+denied`,
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Authentication failed");
    expect(html).toContain("User denied");
    expect(html).toContain("&#10007;");

    await expect(waitPromise).rejects.toThrow("User denied");
    await server.stop(0);
  });

  test("rejects waitForCode on missing code and returns styled error HTML", async () => {
    const server = await createAuthCallbackServer();
    const port = new URL(server.redirectTo).port;

    const waitPromise = server.waitForCode();
    waitPromise.catch(() => {}); // suppress unhandled rejection in test runner

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Authentication failed");
    expect(html).toContain("Missing authorization code");
    expect(html).toContain("&#10007;");

    await expect(waitPromise).rejects.toThrow("Missing authorization code in callback URL");
    await server.stop(0);
  });

  test("escapes HTML in OAuth error description to prevent XSS", async () => {
    const server = await createAuthCallbackServer();
    const port = new URL(server.redirectTo).port;

    const waitPromise = server.waitForCode();
    waitPromise.catch(() => {});

    const maliciousDescription = "<script>alert(1)</script>";
    const res = await fetch(
      `http://127.0.0.1:${port}/auth/callback?error=access_denied&error_description=${encodeURIComponent(maliciousDescription)}`,
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");

    await expect(waitPromise).rejects.toThrow("<script>alert(1)</script>");
    await server.stop(0);
  });

  test("times out when no callback is received", async () => {
    const server = await createAuthCallbackServer();
    await expect(server.waitForCode(50)).rejects.toThrow("Timed out waiting for sign-in callback");
    await server.stop(0);
  });

  test("stop does not resolve synchronously", async () => {
    const server = await createAuthCallbackServer();
    const promise = server.stop(100);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    // Yield to event loop so microtasks run, but macrotasks (timers) are deferred.
    await Promise.resolve();
    expect(resolved).toBe(false);
    await promise;
  });

  test("stop deduplicates multiple calls to the same promise", async () => {
    const server = await createAuthCallbackServer();
    const p1 = server.stop(50);
    const p2 = server.stop(50);
    expect(p1).toBe(p2);
    await p1;
  });
});
