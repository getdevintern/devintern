/**
 * Pure helpers for the in-app project setup wizard — shared by the wizard
 * component and unit tests.
 *
 * Kept in a separate module so tests can import them without being intercepted
 * by other test files that mock the wizard component itself
 * (e.g. `ProjectWorkspaceChrome.test.tsx` stubs `./ProjectSetupWizard.tsx`).
 */

import { PM_TRACKER_SETUP } from "@getdevintern/pm/init-shared";
import type { ProjectInitInspect } from "../../../shared/ipc-contract.ts";

export type WizardMode = "init" | "update";

export type WizardStep =
  | "loading"
  | "overwrite"
  | "reuse"
  | "tracker"
  | "credentials"
  | "probing"
  | "probe-failed"
  | "saving"
  | "error";

/** First step the wizard lands on for a given mode + project snapshot. */
export function firstWizardStep(inspect: ProjectInitInspect, mode: WizardMode): WizardStep {
  if (mode === "update") return "tracker";
  if (inspect.configExists) return "overwrite";
  if (inspect.reusableFromCode) return "reuse";
  return "tracker";
}

/** Step after the overwrite confirmation (init mode only). */
export function stepAfterOverwrite(inspect: ProjectInitInspect): WizardStep {
  if (inspect.reusableFromCode) return "reuse";
  return "tracker";
}

/**
 * Prefill credential values for `trackerId` from the existing project env.
 * Blank/whitespace values are omitted so existing optional values are
 * preserved when the update is written (merge, not overwrite).
 */
export function prefilledValues(
  inspect: ProjectInitInspect,
  trackerId: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  const steps = PM_TRACKER_SETUP[trackerId] ?? [];
  for (const step of steps) {
    const current = inspect.currentEnv[step.key];
    if (current && current.trim()) {
      values[step.key] = current;
    }
  }
  return values;
}
