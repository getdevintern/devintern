import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ReportPreview } from "@/lib/api";
import { REPORT_DOCS_URL, ReportDialogBody } from "./ReportProblem";
import {
  canPreview,
  canSend,
  INITIAL_REPORT_FLOW,
  isReportBusy,
  isReportDraftDirty,
  reportFlowReducer,
} from "./report-flow";
import type { ReportFlowAction, ReportFlowState } from "./report-flow";

function preview(overrides: Partial<ReportPreview> = {}): ReportPreview {
  return {
    previewId: "11111111-2222-3333-4444-555555555555",
    expiresAt: 1_800_000_000_000,
    runId: 42,
    signedIn: false,
    contactRequired: true,
    destination: "https://devintern.com/api/reports",
    title: "Run failed after PR opened",
    description: "Expected success.",
    bytes: 2048,
    attachments: {
      environment: {
        cliVersion: "1.2.3",
        installKind: "bun-global",
        os: "linux",
        arch: "x64",
        ci: false,
        harness: "claude-code",
        signedIn: false,
      },
      run: {
        id: 42,
        status: "failed",
        failedStep: "implement",
        durationMs: 61_000,
        stageCount: 3,
        hasReason: true,
      },
      logs: [{ source: "worker.stderr.log", lines: 12, bytes: 900, truncated: true }],
      evidenceCount: 0,
      identifiersShared: false,
    },
    omitted: ["prompts", "credentials", "task key and repository slug"],
    payload: { reportId: "rid-1", title: "Run failed after PR opened", description: "x" },
    ...overrides,
  };
}

function run(actions: ReportFlowAction[], start = INITIAL_REPORT_FLOW): ReportFlowState {
  return actions.reduce(reportFlowReducer, start);
}

function render(state: ReportFlowState): string {
  return renderToStaticMarkup(
    createElement(ReportDialogBody, {
      state,
      dispatch: () => {},
      onPreview: () => {},
      onSend: () => {},
      onClose: () => {},
    }),
  );
}

const DRAFTED: ReportFlowAction[] = [
  { type: "edit", draft: { title: "Run failed", description: "Expected a PR." } },
];

describe("report flow", () => {
  test("preview needs a title and description", () => {
    expect(canPreview(INITIAL_REPORT_FLOW)).toBe(false);
    expect(canPreview(run([{ type: "edit", draft: { title: "t" } }]))).toBe(false);
    expect(canPreview(run(DRAFTED))).toBe(true);
    // previewStart is ignored until the form is complete.
    expect(run([{ type: "previewStart" }]).phase).toEqual({ step: "compose", busy: false });
  });

  test("compose → preview → sent", () => {
    let state = run([...DRAFTED, { type: "previewStart" }]);
    expect(state.phase).toEqual({ step: "compose", busy: true });
    state = run([{ type: "previewDone", preview: preview() }], state);
    expect(state.phase.step).toBe("preview");

    // Anonymous: Send stays disabled until a valid email is entered.
    expect(canSend(state)).toBe(false);
    state = run([{ type: "email", email: "nope" }], state);
    expect(canSend(state)).toBe(false);
    state = run([{ type: "email", email: "dev@example.com" }], state);
    expect(canSend(state)).toBe(true);

    state = run([{ type: "sendStart" }], state);
    expect(state.phase).toMatchObject({ step: "preview", busy: true });
    state = run(
      [
        {
          type: "sendDone",
          result: { status: "sent", reportId: "abc12345xyz", shortId: "abc12345" },
        },
      ],
      state,
    );
    expect(state.phase.step).toBe("sent");
  });

  test("signed-in previews can be sent without an email", () => {
    const state = run([
      ...DRAFTED,
      { type: "previewStart" },
      { type: "previewDone", preview: preview({ signedIn: true, contactRequired: false }) },
    ]);
    expect(canSend(state)).toBe(true);
  });

  test("editing is blocked once previewed; Back returns to the form", () => {
    let state = run([
      ...DRAFTED,
      { type: "previewStart" },
      { type: "previewDone", preview: preview() },
    ]);
    expect(run([{ type: "edit", draft: { title: "changed" } }], state)).toBe(state);
    state = run([{ type: "back" }], state);
    expect(state.phase.step).toBe("compose");
    expect(state.draft.title).toBe("Run failed");
  });

  test("a saved-locally result can be retried with the same preview", () => {
    const p = preview({ signedIn: true, contactRequired: false });
    let state = run([
      ...DRAFTED,
      { type: "previewStart" },
      { type: "previewDone", preview: p },
      { type: "sendStart" },
      {
        type: "sendDone",
        result: {
          status: "saved",
          error: "Could not reach endpoint",
          authExpired: false,
          savedPath: "/tmp/r.json",
          retryCommand: "devintern report --from /tmp/r.json",
        },
      },
    ]);
    expect(state.phase.step).toBe("saved");
    state = run([{ type: "sendStart" }], state);
    expect(state.phase).toEqual({ step: "preview", preview: p, busy: true });
  });

  test("errors keep the user on the current step", () => {
    const failed = run([
      ...DRAFTED,
      { type: "previewStart" },
      { type: "previewFailed", error: "boom" },
    ]);
    expect(failed.phase).toEqual({ step: "compose", busy: false, error: "boom" });
  });

  test("a typed, unsent draft is dirty; in-flight requests block closing", () => {
    expect(isReportDraftDirty(INITIAL_REPORT_FLOW)).toBe(false);
    expect(isReportDraftDirty(run([{ type: "edit", draft: { shareIdentifiers: true } }]))).toBe(
      false,
    );
    expect(isReportDraftDirty(run(DRAFTED))).toBe(true);

    const previewing = run([...DRAFTED, { type: "previewStart" }]);
    expect(isReportBusy(previewing)).toBe(true);
    const previewed = run([{ type: "previewDone", preview: preview() }], previewing);
    expect(isReportBusy(previewed)).toBe(false);
    expect(isReportDraftDirty(previewed)).toBe(true);
    const sending = run([{ type: "email", email: "a@b.co" }, { type: "sendStart" }], previewed);
    expect(isReportBusy(sending)).toBe(true);

    const sent = run(
      [{ type: "sendDone", result: { status: "sent", reportId: "r", shortId: "r" } }],
      sending,
    );
    expect(isReportDraftDirty(sent)).toBe(false);
    expect(isReportBusy(sent)).toBe(false);
  });
});

describe("report dialog", () => {
  test("compose step shows guidance, secret warning, and identifier opt-in", () => {
    const html = render(INITIAL_REPORT_FLOW);
    expect(html).toContain("configuration issues");
    expect(html).toContain(`href="${REPORT_DOCS_URL}"`);
    expect(html).toContain("What did you expect, and what happened?");
    expect(html).toContain("Do not paste secrets");
    expect(html).toContain("task key and repository slug");
    // Shared shadcn field components, labels bound to their controls.
    expect(html).toContain('data-slot="field"');
    expect(html).toMatch(/<label[^>]*for="report-title"/);
    expect(html).toMatch(/<input[^>]*data-slot="input"[^>]*id="report-title"/);
    expect(html).toMatch(/<textarea[^>]*data-slot="textarea"[^>]*id="report-description"/);
    // Share identifiers is a Radix checkbox, unchecked by default.
    expect(html).toMatch(
      /role="checkbox"[^>]*aria-checked="false"[^>]*id="report-share-identifiers"/,
    );
    expect(html).toContain('data-slot="dialog-footer"');
    expect(html).toContain("Cancel");
    expect(html).toContain("Preview report");
  });

  test("a shared-identifiers draft renders the checkbox checked", () => {
    const html = render(run([{ type: "edit", draft: { shareIdentifiers: true } }]));
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="true"/);
  });

  test("preview step lists attachments, omissions, payload, and an explicit Send", () => {
    const html = render(
      run([...DRAFTED, { type: "previewStart" }, { type: "previewDone", preview: preview() }]),
    );
    expect(html).toContain("devintern 1.2.3");
    expect(html).toContain("Run #42: failed at implement");
    expect(html).toContain("worker.stderr.log");
    expect(html).toContain("prompts, credentials, task key and repository slug");
    expect(html).toContain("Show full payload (2.0 KB)");
    expect(html).toContain("&quot;reportId&quot;: &quot;rid-1&quot;");
    expect(html).toContain("Contact email");
    expect(html).toContain("Send report");
  });

  test("result steps show the report id or the saved path and retry command", () => {
    const base = run([
      ...DRAFTED,
      { type: "previewStart" },
      { type: "previewDone", preview: preview() },
    ]);
    const sent = render(
      run(
        [
          {
            type: "sendDone",
            result: { status: "sent", reportId: "abc12345xyz", shortId: "abc12345" },
          },
        ],
        base,
      ),
    );
    expect(sent).toContain("abc12345");

    const saved = render(
      run(
        [
          {
            type: "sendDone",
            result: {
              status: "saved",
              error: "Report endpoint rejected the report (503)",
              authExpired: true,
              savedPath: "/w/.devintern-code/reports/r.json",
              retryCommand: "devintern report --from /w/.devintern-code/reports/r.json",
            },
          },
        ],
        base,
      ),
    );
    expect(saved).toContain("saved locally");
    expect(saved).toContain("devintern report --from /w/.devintern-code/reports/r.json");
    expect(saved).toContain("devintern login");
    expect(saved).toContain("Try again");
  });
});
