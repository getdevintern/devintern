/**
 * Every redactor masks the same credential shapes (the shared list in
 * `@devintern/utils`) and leaves ordinary text alone.
 *
 * All values are synthetic and assembled at runtime so no literal in this
 * file looks like a real credential to secret scanners.
 */

import { describe, expect, test } from "bun:test";

import { redactText } from "@devintern/utils";

import { redactAgentOutput } from "../src/lib/agent/harness-startup";
import { redactSecrets } from "../src/lib/observability/worker-logs";
import { redactReportText } from "../src/lib/report/redact";
import { sanitizeErrorForPublicComment } from "../src/lib/review/conflict-resolver";

const reportOptions = { cwd: "/nonexistent/report-cwd", homeDir: "/nonexistent/home" };

const REDACTORS: Array<[name: string, redact: (text: string) => string]> = [
  ["redactText", redactText],
  ["redactSecrets", redactSecrets],
  ["redactReportText", (text) => redactReportText(text, reportOptions)],
  ["redactAgentOutput", redactAgentOutput],
];

const r = (char: string, count: number): string => char.repeat(count);
const pem = (kind: string): string =>
  [`-----BEGIN ${kind}-----`, `MIIE${r("Q", 60)}`, `${r("z", 64)}`, `-----END ${kind}-----`].join(
    "\n",
  );

/** [shape, text containing it, substring that must not survive]. */
const SHAPES: Array<[shape: string, text: string, secret: string]> = [
  ["github classic ghp_", `push with ghp_${r("A", 36)} failed`, `ghp_${r("A", 36)}`],
  ["github classic gho_", `token gho_${r("b", 36)}.`, `gho_${r("b", 36)}`],
  ["github classic ghs_", `(ghs_${r("C", 36)})`, `ghs_${r("C", 36)}`],
  ["github classic ghu_", `ghu_${r("d", 36)}`, `ghu_${r("d", 36)}`],
  ["github classic ghr_", `ghr_${r("e", 36)}`, `ghr_${r("e", 36)}`],
  [
    "github fine-grained",
    `using github_pat_${r("A", 22)}_${r("b", 59)} now`,
    `${r("A", 22)}_${r("b", 59)}`,
  ],
  ["gitlab glpat-", `glpat-${r("x", 20)}`, `glpat-${r("x", 20)}`],
  ["gitlab gldt-", `deploy gldt-${r("y", 20)}`, `gldt-${r("y", 20)}`],
  ["gitlab glptt-", `glptt-${r("a", 40)}`, `glptt-${r("a", 40)}`],
  ["gitlab glrt-", `glrt-${r("B", 20)}`, `glrt-${r("B", 20)}`],
  ["gitlab glcbt-", `glcbt-${r("c", 30)}`, `glcbt-${r("c", 30)}`],
  ["slack xoxb-", `xoxb-${r("1", 12)}-${r("a", 24)}`, r("a", 24)],
  ["slack xoxp-", `slack xoxp-${r("2", 12)}-${r("b", 24)}`, r("b", 24)],
  ["aws AKIA", `key AKIA${r("Q", 16)} denied`, `AKIA${r("Q", 16)}`],
  ["aws ASIA", `ASIA${r("Z", 16)}`, `ASIA${r("Z", 16)}`],
  ["openai sk-", `sk-proj-${r("a", 40)}`, r("a", 40)],
  ["anthropic sk-ant-", `sk-ant-api03-${r("b", 40)}-${r("c", 6)}`, r("b", 40)],
  ["atlassian ATATT", `jira ATATT3x${r("F", 30)}=${r("0", 8)}`, r("F", 30)],
  ["linear lin_api_", `lin_api_${r("k", 40)}`, `lin_api_${r("k", 40)}`],
  ["linear lin_oauth_", `lin_oauth_${r("m", 40)}`, `lin_oauth_${r("m", 40)}`],
  ["sentry sntrys_", `sntrys_eyJ${r("a", 40)}`, r("a", 40)],
  ["sentry sntryu_", `sntryu_${r("f", 64)}`, r("f", 64)],
  ["polar", `polar_oat_${r("p", 40)}`, `polar_oat_${r("p", 40)}`],
  ["npm", `npm_${r("n", 36)}`, `npm_${r("n", 36)}`],
  ["google api key", `AIza${r("g", 35)}`, `AIza${r("g", 35)}`],
  ["stripe secret", `${"sk"}_live_${r("s", 24)}`, r("s", 24)],
  ["stripe restricted", `${"rk"}_test_${r("t", 24)}`, r("t", 24)],
  [
    "jwt",
    `jwt eyJ${r("h", 20)}.eyJ${r("p", 30)}.${r("s", 43)} expired`,
    `eyJ${r("p", 30)}.${r("s", 43)}`,
  ],
  ["pem rsa private key", `key:\n${pem("RSA PRIVATE KEY")}\nend`, r("z", 64)],
  ["pem pkcs8 private key", pem("PRIVATE KEY"), `MIIE${r("Q", 60)}`],
  ["pem openssh private key", pem("OPENSSH PRIVATE KEY"), r("z", 64)],
  ["bearer", `Authorization: Bearer ${r("q", 30)}`, r("q", 30)],
  ["bearer jwt", `bearer eyJ${r("a", 10)}.eyJ${r("b", 10)}.${r("c", 10)}`, r("b", 10)],
  ["basic auth header", `Authorization: Basic ${r("d", 16)}Ojh=`, `${r("d", 16)}Ojh=`],
  ["basic auth json", `{"Authorization": "Basic ${r("e", 20)}=="}`, `${r("e", 20)}==`],
  ["url userinfo", "clone https://ci-bot:s3cretPassw0rd@git.example.com/x.git", "s3cretPassw0rd"],
  ["url userinfo http", "http://user:hunter2hunter2@proxy.local:8080", "hunter2hunter2"],
  ["query token", "GET https://api.example.com/v1?token=abc123def&page=2", "abc123def"],
  ["query access_token", "https://x.test/cb?a=1&access_token=zzzTOKENzzz", "zzzTOKENzzz"],
  ["query api_key", "https://x.test/v1?api_key=keyvalue123", "keyvalue123"],
  ["query passwd", "https://s3.example/obj?passwd=hunter2&x=1", "hunter2"],
  ["query github_token", "https://x.test/v1?a=1&github_token=abc123secret", "abc123secret"],
  ["query auth_token", "https://x.test/v1?auth_token=abc123secret#frag", "abc123secret"],
  ["query access_key", "https://x.test/v1?access_key=AKVALUE99", "AKVALUE99"],
  ["query private_key", "https://x.test/v1?private_key=zzzprivzzz", "zzzprivzzz"],
  ["query clientPat", "https://x.test/v1?clientPat=patvalue123", "patvalue123"],
  ["assignment pat suffix", "MYPAT=patvalue456", "patvalue456"],
  ["assignment gitlab pat", "GITLAB_PAT: patvalue789", "patvalue789"],
  ["assignment env", "GITHUB_TOKEN=plainvalue123 done", "plainvalue123"],
  ["assignment json", '{"password": "hunter2 spaced"}', "hunter2 spaced"],
  ["assignment yaml", "client_secret: yamlsecretvalue", "yamlsecretvalue"],
];

/** Ordinary text that every redactor must leave unchanged. */
const BENIGN: string[] = [
  "Agent exited with code 1",
  "patch: failed to apply",
  "path: /usr/local/lib/node_modules/devintern/dist/index.js",
  "compatible: yes",
  "commit 3f9a2c1d4e5b6a7980f1e2d3c4b5a69788d1e0f2 on main",
  "negotiated HTTP-2 with the proxy",
  "UTF-8 and SHA-256",
  "see https://github.com/acme/widgets/pull/7?tab=files",
  "WORKER_POLL_INTERVAL=30",
  "risk-assessment and task-skipped are fine",
  "max_tokens_per_run is a setting name",
  "max_tokens: 4096",
  "maxTokens=4096",
  "tokens: 12000 used",
  "input_tokens=120 output_tokens=80",
  "compat_mode: legacy",
  "Bearer tokens are documented in the README",
  "Basic usage: devintern run",
];

describe.each(REDACTORS)("%s", (_name, redact) => {
  test.each(SHAPES)("masks %s", (_shape, text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted");
  });

  test.each(BENIGN)("leaves %p unchanged", (text) => {
    expect(redact(text)).toBe(text);
  });

  test("redacts long inputs without matches in linear time", () => {
    const inputs = [
      r("a", 100_000),
      r("A1_-", 25_000),
      r("http://a:", 11_112),
      r("eyJa.", 20_000),
      r("ghp_", 25_000),
      r("tokentoken", 10_000),
      r("MII", 33_334),
      r("x ", 50_000),
      r('"k": ', 20_000),
      r("a:", 50_000),
      r('a: "', 33_334),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redact(input);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe("redactAgentOutput DER key bodies", () => {
  const der = `MIIEvQIBADANBg${r("k", 40)}`;

  test.each([
    ["bare", `key ${der} end`],
    ["after =", `der=${der}`],
    ["after +", `x+${der}`],
    ["glued onto base64", `x${der}`],
  ])("masks a DER body %s", (_case, text) => {
    expect(redactAgentOutput(text)).not.toContain(der.slice(0, 20));
  });

  test("stays linear on many short MII runs", () => {
    for (const input of [r(`MII${r("a", 39)} `, 5_000), r("+/MII", 20_000), r("=MII", 25_000)]) {
      const started = performance.now();
      redactAgentOutput(input);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe("sanitizeErrorForPublicComment", () => {
  test.each(SHAPES)("masks %s", (_shape, text, secret) => {
    expect(sanitizeErrorForPublicComment(text)).not.toContain(secret);
  });

  test("handles long inputs without matches in linear time", () => {
    for (const input of [r("a", 100_000), r("a:b", 33_334), r("ab://", 20_000)]) {
      const started = performance.now();
      sanitizeErrorForPublicComment(input);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
