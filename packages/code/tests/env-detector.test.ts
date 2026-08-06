import { describe, expect, test } from "bun:test";

import {
  cgroupIndicatesSystemdService,
  getRuntimeMode,
  isAutomatedEnvironment,
} from "../src/lib/env-detector";

const desktopScopeCgroup =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-2784442.scope\n";
const serviceCgroup = "0::/system.slice/devintern-intern.service\n";

describe("cgroupIndicatesSystemdService", () => {
  test("detects system and transient .service units", () => {
    expect(cgroupIndicatesSystemdService(serviceCgroup)).toBe(true);
    expect(
      cgroupIndicatesSystemdService(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-p123.service\n",
      ),
    ).toBe(true);
    expect(cgroupIndicatesSystemdService("0::/system.slice/cron.service\n")).toBe(true);
  });

  test("rejects desktop .scope units and bare user manager", () => {
    expect(cgroupIndicatesSystemdService(desktopScopeCgroup)).toBe(false);
    expect(
      cgroupIndicatesSystemdService(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-graphical.slice/app-Hyprland-xdg\\x2dterminal\\x2dexec-d30ba5c3.scope\n",
      ),
    ).toBe(false);
    expect(
      cgroupIndicatesSystemdService("0::/user.slice/user-1000.slice/user@1000.service\n"),
    ).toBe(false);
  });

  test("handles cgroup v1 systemd controller lines", () => {
    expect(
      cgroupIndicatesSystemdService("12:name=systemd:/system.slice/devintern-worker.service\n"),
    ).toBe(true);
    expect(
      cgroupIndicatesSystemdService(
        "12:name=systemd:/user.slice/user-1000.slice/session-1.scope\n",
      ),
    ).toBe(false);
  });
});

describe("isAutomatedEnvironment", () => {
  test("treats CI as automated", () => {
    expect(
      isAutomatedEnvironment({
        env: { CI: "true" },
        cgroupContents: desktopScopeCgroup,
      }),
    ).toBe(true);
  });

  test("does not treat inherited desktop systemd env vars as automated", () => {
    // Omarchy / Hyprland / Cursor: every GUI terminal inherits these from a parent unit.
    expect(
      isAutomatedEnvironment({
        env: {
          INVOCATION_ID: "7066d91c517541fb8821750516a1ebf0",
          JOURNAL_STREAM: "10:26670",
          SYSTEMD_EXEC_PID: "2394",
        },
        pid: 99999,
        cgroupContents: desktopScopeCgroup,
      }),
    ).toBe(false);
  });

  test("treats matching SYSTEMD_EXEC_PID as automated", () => {
    expect(
      isAutomatedEnvironment({
        env: { SYSTEMD_EXEC_PID: "4242" },
        pid: 4242,
        cgroupContents: desktopScopeCgroup,
      }),
    ).toBe(true);
  });

  test("treats a .service cgroup as automated even when ExecStart is a wrapper", () => {
    expect(
      isAutomatedEnvironment({
        env: { SYSTEMD_EXEC_PID: "100" }, // wrapper bash, not us
        pid: 200,
        cgroupContents: serviceCgroup,
      }),
    ).toBe(true);
  });

  test("getRuntimeMode reflects the live process", () => {
    expect(["interactive", "automated"]).toContain(getRuntimeMode());
  });
});
