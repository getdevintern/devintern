import { describe, expect, test } from "bun:test";
import { hasMacSigningCredentials, resolveSigningEnv } from "../scripts/signing-env.ts";

describe("signing-env gate", () => {
  test("reports unsigned when no credentials are set", () => {
    const result = resolveSigningEnv({});
    expect(result.mode).toBe("unsigned");
    expect(result.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(hasMacSigningCredentials({})).toBe(false);
  });

  test("detects mac credentials from CSC_LINK", () => {
    const env = { CSC_LINK: "file:///certs/mac.p12", CSC_KEY_PASSWORD: "secret" };
    expect(hasMacSigningCredentials(env)).toBe(true);
    const result = resolveSigningEnv(env);
    expect(result.mode).toBe("mac");
    expect(result.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("true");
  });

  test("detects mac credentials from CSC_NAME", () => {
    const result = resolveSigningEnv({ CSC_NAME: "Developer ID Application: Acme" });
    expect(result.mode).toBe("mac");
    expect(hasMacSigningCredentials({ CSC_NAME: "Developer ID Application: Acme" })).toBe(true);
  });

  test("respects empty/whitespace credentials as unset", () => {
    expect(hasMacSigningCredentials({ CSC_LINK: "   " })).toBe(false);
    expect(resolveSigningEnv({ CSC_LINK: "" }).mode).toBe("unsigned");
  });

  test("clears empty CI secret placeholders", () => {
    const result = resolveSigningEnv({
      CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
    });
    expect(result.mode).toBe("unsigned");
    expect(result.env.CSC_LINK).toBeUndefined();
    expect(result.env.CSC_KEY_PASSWORD).toBeUndefined();
    expect(result.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
  });
});
