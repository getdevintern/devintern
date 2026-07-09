import { describe, expect, test } from "bun:test";
import { parseTrelloCardReference } from "./src/clients/trello.ts";

describe("parseTrelloCardReference", () => {
  test("returns short link unchanged", () => {
    expect(parseTrelloCardReference("4uWKPOTv")).toBe("4uWKPOTv");
  });

  test("returns 24-character card ID unchanged", () => {
    expect(parseTrelloCardReference("507f1f77bcf86cd799439011")).toBe("507f1f77bcf86cd799439011");
  });

  test("extracts short link from full card URL", () => {
    expect(
      parseTrelloCardReference(
        "https://trello.com/c/4uWKPOTv/27-show-task-tracker-and-project-in-interactive-ui-header",
      ),
    ).toBe("4uWKPOTv");
  });

  test("extracts short link from URL without slug", () => {
    expect(parseTrelloCardReference("https://trello.com/c/4uWKPOTv")).toBe("4uWKPOTv");
  });

  test("trims whitespace around input", () => {
    expect(parseTrelloCardReference("  4uWKPOTv  ")).toBe("4uWKPOTv");
  });
});
