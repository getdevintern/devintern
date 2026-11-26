import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_PATTERNS,
  findCredentialShapes,
  REDACTED,
  REDACTED_PRIVATE_KEY,
  redactText,
} from "./src/redact.ts";

describe("redactText", () => {
  test("masks secret-key assignments", () => {
    expect(redactText("GITHUB_TOKEN=abc123 done")).toBe(`GITHUB_TOKEN=${REDACTED} done`);
    expect(redactText('{"password": "p@ss word"}')).toBe(`{"password": ${REDACTED}}`);
    expect(redactText("access-key = 'abc def'")).toBe(`access-key = ${REDACTED}`);
    expect(redactText("path: /usr/lib")).toBe("path: /usr/lib");
    // A non-secret key must not swallow a secret key in its value.
    expect(redactText('error: {"password": "x", "apiKey": "y"}')).toBe(
      `error: {"password": ${REDACTED}, "apiKey": ${REDACTED}}`,
    );
  });

  test("keeps the rest of a URL after a query credential", () => {
    expect(redactText("https://x.test/?a=1&token=abc&b=2")).toBe(
      `https://x.test/?a=1&token=${REDACTED}&b=2`,
    );
    // Any secret-shaped query key, not just the fixed query-rule names.
    expect(redactText("https://s3.example/obj?passwd=hunter2&x=1#f")).toBe(
      `https://s3.example/obj?passwd=${REDACTED}&x=1#f`,
    );
    expect(redactText("https://x.test/?github_token=abc&tab=files")).toBe(
      `https://x.test/?github_token=${REDACTED}&tab=files`,
    );
  });

  test("masks PEM blocks and lone headers", () => {
    const block = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(redactText(`x ${block} y`)).toBe(`x ${REDACTED_PRIVATE_KEY} y`);
    expect(redactText("-----BEGIN RSA PRIVATE KEY-----\ntrunc")).toBe(
      `${REDACTED_PRIVATE_KEY}\ntrunc`,
    );
  });

  test("masks plural token keys unless the value is a count", () => {
    expect(redactText("API_TOKENS=abc123")).toBe(`API_TOKENS=${REDACTED}`);
    expect(redactText("refreshTokens: abc123")).toBe(`refreshTokens: ${REDACTED}`);
    expect(redactText("max_tokens: 4096 exceeded")).toBe("max_tokens: 4096 exceeded");
    expect(redactText("?max_tokens=4096&x=1")).toBe("?max_tokens=4096&x=1");
  });

  test("masks tokens that follow a dash", () => {
    expect(redactText(`id-AKIA${"Q".repeat(16)}`)).toBe(`id-${REDACTED}`);
    expect(redactText(`x-ghp_${"a".repeat(36)}`)).toBe(`x-${REDACTED}`);
  });

  test("masks tokens that end in - or _", () => {
    expect(redactText(`t glpat-${"a".repeat(19)}-`)).toBe(`t ${REDACTED}`);
  });

  test("every shared pattern is global", () => {
    for (const { pattern } of CREDENTIAL_PATTERNS) expect(pattern.flags).toContain("g");
  });
});

describe("findCredentialShapes", () => {
  test("reports unmasked shapes once and ignores masked values", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(findCredentialShapes(`${token} ${token}`)).toEqual(["github token"]);
    expect(
      findCredentialShapes(redactText(`?token=abc ${token} Bearer ${"x".repeat(20)}`)),
    ).toEqual([]);
  });
});
