import { describe, expect, test } from "bun:test";
import { azureDevOpsFakeBaseUrl } from "./src/config/azure-devops-fake.ts";

const INVALID = "AZURE_DEVOPS_BASE_URL must be an absolute loopback http(s) URL";

describe("azureDevOpsFakeBaseUrl", () => {
  test("ignores every value when the process did not opt in", () => {
    expect(azureDevOpsFakeBaseUrl("http://127.0.0.1:9/fakeorg", false)).toBeUndefined();
    expect(azureDevOpsFakeBaseUrl("https://attacker.example/collect", false)).toBeUndefined();
    expect(azureDevOpsFakeBaseUrl("not a url", false)).toBeUndefined();
  });

  test("returns undefined for an unset, empty, or blank value when opted in", () => {
    expect(azureDevOpsFakeBaseUrl(undefined, true)).toBeUndefined();
    expect(azureDevOpsFakeBaseUrl("", true)).toBeUndefined();
    expect(azureDevOpsFakeBaseUrl("   ", true)).toBeUndefined();
  });

  test("accepts and normalizes a loopback http(s) URL when opted in", () => {
    expect(azureDevOpsFakeBaseUrl(" http://127.0.0.1:4321/fakeorg/ ", true)).toBe(
      "http://127.0.0.1:4321/fakeorg",
    );
    expect(azureDevOpsFakeBaseUrl("https://[::1]:8443/org", true)).toBe("https://[::1]:8443/org");
  });

  test.each([
    "https://attacker.example/collect",
    "http://localhost:9/org",
    "http://127.0.0.2:9/org",
    "ftp://127.0.0.1/org",
    "http://user:pw@127.0.0.1:9/org",
    "http://127.0.0.1:9/org?x=1",
    "http://127.0.0.1:9/org#frag",
    "/relative/path",
  ])("refuses %s when opted in", (raw) => {
    expect(() => azureDevOpsFakeBaseUrl(raw, true)).toThrow(INVALID);
  });

  test("defaults to the opt-in captured at module load", () => {
    // The test process does not set DEVINTERN_E2E_FAKE_AZURE_DEVOPS.
    if (process.env.DEVINTERN_E2E_FAKE_AZURE_DEVOPS === "1") return;
    expect(azureDevOpsFakeBaseUrl("http://127.0.0.1:9/fakeorg")).toBeUndefined();
  });
});
