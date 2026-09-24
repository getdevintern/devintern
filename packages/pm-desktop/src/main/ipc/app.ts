import { app, shell } from "electron";
import { parseRendererErrorReport, IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import { getAnalyticsEnabled, setAnalyticsEnabled } from "../analytics.ts";
import { captureErrorOnce } from "../error-tracking.ts";
import {
  switchEffort,
  switchHarness,
  switchModel,
  switchProjectKey,
  switchTracker,
  updateProjectFromRemote,
} from "../session.ts";
import { readSettings, updateSettings } from "../settings.ts";
import { handle } from "./register.ts";

/** App metadata, analytics, renderer-error, and context-switch IPC handlers. */
export function registerAppIpcHandlers(): void {
  handle(IPC_CHANNELS.openExternal, async (_event, url: string) => {
    if (!/^https?:\/\//.test(url) && !url.startsWith("file://")) {
      throw new Error("Only http(s) and file URLs can be opened externally.");
    }
    await shell.openExternal(url);
    return null;
  });

  handle(IPC_CHANNELS.getAppVersion, async () => {
    // Packaged builds: version from app metadata / package.json.
    // Dev runs: same package.json version via Electron's default resolution.
    return app.getVersion();
  });

  handle(IPC_CHANNELS.isCodeDiscoveryDismissed, async () => {
    const settings = await readSettings();
    return settings.codeDiscoveryDismissed === true;
  });

  handle(IPC_CHANNELS.dismissCodeDiscovery, async () => {
    await updateSettings({ codeDiscoveryDismissed: true });
    return null;
  });

  handle(IPC_CHANNELS.getAnalyticsEnabled, async () => {
    return getAnalyticsEnabled();
  });

  handle(IPC_CHANNELS.setAnalyticsEnabled, async (_event, enabled: boolean) => {
    await setAnalyticsEnabled(enabled);
    return null;
  });

  // Renderer → main error forwarding (window error/unhandledrejection/React
  // boundary). Malformed reports are dropped silently: reporting must not
  // feed back into reporting. Actual capture respects the telemetry toggle
  // and SENTRY_DISABLED=1 via the shared tracking state.
  handle(IPC_CHANNELS.reportRendererError, async (_event, report: unknown) => {
    const parsed = parseRendererErrorReport(report);
    if (!parsed) {
      return null;
    }
    const error = new Error(parsed.message);
    if (parsed.stack) {
      error.stack = parsed.stack;
    }
    await captureErrorOnce(error, {
      operation: "renderer",
      kind: parsed.kind,
      ...(parsed.componentStack ? { componentStack: parsed.componentStack } : {}),
    });
    return null;
  });

  handle(IPC_CHANNELS.switchTracker, async (_event, trackerId: string) => {
    // Works even when the current tracker failed to load, so the user can
    // switch to another fully configured tracker without re-running setup.
    return switchTracker(trackerId);
  });

  handle(IPC_CHANNELS.switchProjectKey, async (_event, projectKey: string) => {
    return switchProjectKey(projectKey);
  });

  handle(IPC_CHANNELS.switchHarness, async (_event, harnessName: string) => {
    return switchHarness(harnessName);
  });

  handle(IPC_CHANNELS.switchModel, async (_event, model: string) => {
    return switchModel(model);
  });

  handle(IPC_CHANNELS.switchEffort, async (_event, effort: string) => {
    return switchEffort(effort);
  });

  handle(IPC_CHANNELS.updateProjectFromRemote, async () => {
    return updateProjectFromRemote();
  });
}
