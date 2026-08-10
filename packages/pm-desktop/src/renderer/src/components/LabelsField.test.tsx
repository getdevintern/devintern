import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LabelsField } from "./LabelsField.tsx";

const noop = () => {};

describe("LabelsField", () => {
  test("shows truncated catalog affordance", () => {
    const html = renderToStaticMarkup(
      createElement(LabelsField, {
        available: Array.from({ length: 3 }, (_, i) => ({
          id: `lab-${i}`,
          name: `label-${i}`,
        })),
        selected: [],
        onChange: noop,
        loading: false,
        error: null,
        truncated: true,
      }),
    );
    expect(html).toContain("Showing first 3 labels; more may exist in the tracker.");
  });

  test("shows empty-state copy when the tracker has no labels", () => {
    const html = renderToStaticMarkup(
      createElement(LabelsField, {
        available: [],
        selected: [],
        onChange: noop,
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("No existing labels in this tracker.");
    expect(html).toContain("Select labels…");
  });

  test("allows creating labels when allowCreate is set", () => {
    const html = renderToStaticMarkup(
      createElement(LabelsField, {
        available: [],
        selected: [],
        onChange: noop,
        loading: false,
        error: null,
        allowCreate: true,
      }),
    );
    expect(html).toContain("Type or select labels…");
    expect(html).toContain("Type any label name; existing ones appear as suggestions.");
    expect(html).not.toContain("No existing labels in this tracker.");
  });

  test("renders selected chips", () => {
    const html = renderToStaticMarkup(
      createElement(LabelsField, {
        available: [
          { id: "bug", name: "bug" },
          { id: "backend", name: "backend" },
        ],
        selected: ["bug", "backend"],
        onChange: noop,
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("bug");
    expect(html).toContain("backend");
    expect(html).toContain('data-slot="combobox-chip"');
  });
});
