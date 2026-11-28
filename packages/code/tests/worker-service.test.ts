import { describe, test, expect } from "bun:test";

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  checkServiceManager,
  detectWorkerService,
  installWorkerService,
  LAUNCHD_PLIST_NAME,
  launchdAgentPath,
  manualServiceInstructions,
  renderLaunchdPlist,
  renderSystemdUnit,
  SERVICE_MANAGED_MARKER,
  SYSTEMD_UNIT_NAME,
  systemdUnitPath,
  userBusEnv,
} from "../src/lib/worker/service";
import type { RunCommandFn, WorkerServiceDeps } from "../src/lib/worker/service";

/** In-memory fs + command recorder so rollback behavior is directly assertable. */
function fakeServiceDeps(options: {
  platform: NodeJS.Platform;
  files?: Record<string, string>;
  run?: RunCommandFn;
  uid?: number;
  homedir?: string;
}): { deps: WorkerServiceDeps; files: Map<string, string>; commands: string[][] } {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const commands: string[][] = [];
  const run: RunCommandFn =
    options.run ??
    (async (command, args) => {
      commands.push([command, ...args]);
      if (args.includes("is-active") || args.includes("is-enabled")) {
        return inactive;
      }
      // launchd reports the label as absent until an agent file exists.
      if (args[0] === "print") {
        const loaded = [...files.keys()].some((key) => key.endsWith(LAUNCHD_PLIST_NAME));
        return loaded ? running : inactive;
      }
      return ok;
    });
  return {
    files,
    commands,
    deps: {
      platform: options.platform,
      homedir: options.homedir ?? "/home/tester",
      uid: options.uid,
      exists: (p) => files.has(p),
      readFile: (p) => {
        const content = files.get(p);
        if (content === undefined) {
          throw new Error(`ENOENT: ${p}`);
        }
        return content;
      },
      writeFile: (p, content) => {
        files.set(p, content);
      },
      mkdir: () => {},
      remove: (p) => {
        files.delete(p);
      },
      run,
    },
  };
}

const ok = { status: 0, stdout: "", stderr: "" };
const running = { status: 0, stdout: "state = running", stderr: "" };
const inactive = { status: 1, stdout: "", stderr: "" };
const managedUnit = `# ${SERVICE_MANAGED_MARKER}\n[Service]\n`;
const managedPlist = `<!-- ${SERVICE_MANAGED_MARKER} -->\n<plist/>`;

describe("service paths", () => {
  test("uses the user-level systemd and LaunchAgents locations", () => {
    expect(systemdUnitPath("/home/tester")).toBe(
      "/home/tester/.config/systemd/user/devintern-worker.service",
    );
    expect(launchdAgentPath("/Users/tester")).toBe(
      "/Users/tester/Library/LaunchAgents/com.devintern.worker.plist",
    );
  });
});

describe("detectWorkerService", () => {
  test("reports installed but inactive when systemctl says so", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    const { deps } = fakeServiceDeps({
      platform: "linux",
      files: { [unitPath]: "[Service]" },
      run: async () => inactive,
    });
    expect(await detectWorkerService(deps)).toEqual({
      installed: true,
      active: false,
      managed: false,
    });
  });

  test("reports an active macOS agent via launchctl print", async () => {
    const { deps } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      files: { [launchdAgentPath("/Users/tester")]: "<plist/>" },
      uid: 501,
      run: async (command, args) => {
        expect(command).toBe("launchctl");
        expect(args).toEqual(["print", "gui/501/com.devintern.worker"]);
        return running;
      },
    });
    expect(await detectWorkerService(deps)).toEqual({
      installed: true,
      active: true,
      managed: false,
    });
  });

  test("does not call a loaded but exited macOS agent active", async () => {
    const agentPath = launchdAgentPath("/Users/tester");
    const { deps } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      files: { [agentPath]: managedPlist },
      uid: 501,
      run: async () => ({ status: 0, stdout: "state = exited\nlast exit code = 1", stderr: "" }),
    });
    expect(await detectWorkerService(deps)).toEqual({
      installed: true,
      active: false,
      managed: true,
    });
  });

  test("treats other platforms as not installed", async () => {
    const { deps } = fakeServiceDeps({ platform: "win32" });
    expect(await detectWorkerService(deps)).toEqual({
      installed: false,
      active: false,
      managed: false,
    });
  });
});

describe("installWorkerService on Linux", () => {
  test("installs into the user unit directory and enables the service", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    let enabled = false;
    const { deps, files, commands } = fakeServiceDeps({
      platform: "linux",
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (args.includes("is-active")) {
          return enabled ? ok : inactive;
        }
        if (args.includes("is-enabled")) {
          return inactive;
        }
        if (args.includes("enable")) {
          enabled = true;
        }
        return ok;
      },
    });
    const result = await installWorkerService(
      {
        workspaceDir: "/srv/workspace",
        execPath: "/usr/local/bin/devintern",
        runtimePath: "/opt/bun/bin/bun",
        environmentPath: "/opt/bun/bin:/usr/bin",
      },
      { ...deps, username: "tester" },
    );
    expect(result).toEqual({ ok: true, updated: false });
    const unit = files.get(unitPath) ?? "";
    expect(unit).toContain("WorkingDirectory=/srv/workspace");
    expect(unit).toContain('Environment="PATH=/opt/bun/bin:/usr/bin"');
    expect(unit).toContain("ExecStart=/opt/bun/bin/bun /usr/local/bin/devintern worker");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Type=simple");
    expect(unit).not.toContain("StandardOutput=");
    expect(commands).toEqual([
      ["systemctl", "--user", "is-active", "devintern-worker"],
      ["systemctl", "--user", "is-enabled", "devintern-worker"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "reset-failed", "devintern-worker"],
      ["systemctl", "--user", "enable", "--now", "devintern-worker"],
      // No `is-active` here: it says "active" even for a worker that exits a
      // second later; callers run the honest start check instead.
      ["loginctl", "show-user", "tester", "--property=Linger", "--value"],
      ["loginctl", "enable-linger", "tester"],
    ]);
  });

  test("restarts instead of enabling when the service already runs", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    const { deps, commands } = fakeServiceDeps({
      platform: "linux",
      files: { [unitPath]: managedUnit },
      run: async (command, args) => {
        commands.push([command, ...args]);
        return ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      deps,
    );
    expect(result).toEqual({ ok: true, updated: true });
    expect(commands).toContainEqual(["systemctl", "--user", "restart", "devintern-worker"]);
    expect(commands).not.toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "devintern-worker",
    ]);
  });

  test("clears a start-limit counter before restarting a running service", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    const commands: string[][] = [];
    let startLimitCleared = false;
    const { deps } = fakeServiceDeps({
      platform: "linux",
      files: { [unitPath]: managedUnit },
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (args.includes("reset-failed")) startLimitCleared = true;
        if (args.includes("is-active") || args.includes("is-enabled")) return ok;
        // systemd refuses a restart while the unit is in `start-limit-hit`.
        if (args.includes("restart") && !startLimitCleared) {
          return {
            status: 1,
            stdout: "",
            stderr:
              "Job for devintern-worker.service failed because start of the service was attempted too often.",
          };
        }
        return ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      deps,
    );
    expect(result).toEqual({ ok: true, updated: true });
    const reset = commands.findIndex(([, , verb]) => verb === "reset-failed");
    const restart = commands.findIndex(([, , verb]) => verb === "restart");
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThan(restart);
  });

  test("refuses to overwrite a custom systemd unit", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    const { deps, files, commands } = fakeServiceDeps({
      platform: "linux",
      files: { [unitPath]: "[Service]\nEnvironment=KEEP_ME=yes\n" },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("custom service definition");
    expect(files.get(unitPath)).toContain("KEEP_ME=yes");
    expect(commands).toEqual([]);
  });

  test("keeps the service but warns when lingering cannot be enabled", async () => {
    let enabled = false;
    const { deps } = fakeServiceDeps({
      platform: "linux",
      run: async (command, args) => {
        if (command === "loginctl") {
          return { status: 1, stdout: "", stderr: "Access denied" };
        }
        if (args.includes("is-active")) return enabled ? ok : inactive;
        if (args.includes("is-enabled")) return inactive;
        if (args.includes("enable")) enabled = true;
        return ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      { ...deps, username: "tester" },
    );
    expect(result.ok).toBe(true);
    expect(result.warning).toBe(
      "could not enable lingering for tester (Access denied). Until it is, the worker stops when you log out and does not start at boot. Run as root: sudo loginctl enable-linger tester",
    );
  });

  test("skips enable-linger when lingering is already on", async () => {
    const commands: string[][] = [];
    const { deps } = fakeServiceDeps({
      platform: "linux",
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (command === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
        return args.includes("is-active") || args.includes("is-enabled") ? inactive : ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      { ...deps, username: "tester" },
    );
    expect(result).toEqual({ ok: true, updated: false });
    expect(commands.filter(([command]) => command === "loginctl")).toEqual([
      ["loginctl", "show-user", "tester", "--property=Linger", "--value"],
    ]);
  });

  test("asks `id -un` when the login name is not known", async () => {
    const commands: string[][] = [];
    const { deps } = fakeServiceDeps({
      platform: "linux",
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (command === "id") return { status: 0, stdout: "tester\n", stderr: "" };
        if (command === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
        return args.includes("is-active") || args.includes("is-enabled") ? inactive : ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      { ...deps, username: "" },
    );
    expect(result.warning).toBeUndefined();
    expect(commands).toContainEqual([
      "loginctl",
      "show-user",
      "tester",
      "--property=Linger",
      "--value",
    ]);
  });

  test("exports a non-default workspace home to the unit", async () => {
    const { deps, files } = fakeServiceDeps({ platform: "linux" });
    await installWorkerService({ workspaceDir: "/srv/workspace", execPath: "devintern" }, deps);
    expect(files.get(systemdUnitPath("/home/tester"))).toContain(
      'Environment="DEVINTERN_WORKSPACE_DIR=/srv/workspace"\n',
    );
    const { deps: defaultDeps, files: defaultFiles } = fakeServiceDeps({ platform: "linux" });
    await installWorkerService(
      { workspaceDir: "/home/tester/.devintern", execPath: "devintern" },
      defaultDeps,
    );
    expect(defaultFiles.get(systemdUnitPath("/home/tester"))).not.toContain(
      "DEVINTERN_WORKSPACE_DIR",
    );
  });

  test("removes a freshly written unit when the systemd user session fails (WSL)", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    const commands: string[][] = [];
    const { deps, files } = fakeServiceDeps({
      platform: "linux",
      run: async (command, args) => {
        commands.push([command, ...args]);
        return args.includes("daemon-reload")
          ? {
              status: 1,
              stdout: "",
              stderr: "System has not been booted with systemd as init system (PID 1).",
            }
          : inactive;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("daemon-reload failed");
    expect(files.has(unitPath)).toBe(false);
    expect(commands).toContainEqual(["systemctl", "--user", "disable", "devintern-worker"]);
  });

  test("restores the previous unit content when a restart fails", async () => {
    const unitPath = systemdUnitPath("/home/tester");
    const { deps, files } = fakeServiceDeps({
      platform: "linux",
      files: { [unitPath]: managedUnit },
      run: async (_command, args) => (args.includes("restart") ? { ...ok, status: 1 } : ok),
    });
    const result = await installWorkerService(
      { workspaceDir: "/srv/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(files.get(unitPath)).toBe(managedUnit);
  });
});

describe("service rollback leaves no empty directories", () => {
  test("a failed first install removes the unit directories it created, not older ones", async () => {
    const home = mkdtempSync(join(tmpdir(), "devintern-service-home-"));
    try {
      mkdirSync(join(home, ".config"));
      const result = await installWorkerService(
        { workspaceDir: "/srv/workspace", execPath: "devintern" },
        {
          platform: "linux",
          homedir: home,
          run: async (_command, args) =>
            args.includes("daemon-reload")
              ? { status: 1, stdout: "", stderr: "Failed to connect to bus" }
              : inactive,
        },
      );
      expect(result.ok).toBe(false);
      expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
      // ~/.config existed before the install, so it stays.
      expect(existsSync(join(home, ".config"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("checkServiceManager", () => {
  test("is available when the systemd user manager answers", async () => {
    const { deps, commands } = fakeServiceDeps({ platform: "linux" });
    expect(await checkServiceManager(deps)).toEqual({ available: true });
    expect(commands).toEqual([["systemctl", "--user", "show-environment"]]);
  });

  test("reports a missing systemctl binary", async () => {
    const { deps } = fakeServiceDeps({
      platform: "linux",
      run: async () => ({ status: 127, stdout: "", stderr: "ENOENT" }),
    });
    expect(await checkServiceManager(deps)).toEqual({
      available: false,
      reason: "systemctl is not installed",
    });
  });

  test("reports a missing user session (containers, WSL without systemd)", async () => {
    const { deps } = fakeServiceDeps({
      platform: "linux",
      run: async () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus" }),
    });
    const result = await checkServiceManager(deps);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain("no systemd user session");
  });

  test("a missing user manager gets an actionable message", async () => {
    const { deps } = fakeServiceDeps({
      platform: "linux",
      uid: 1000,
      run: async () => ({ status: 1, stdout: "", stderr: "No medium found" }),
    });
    const result = await checkServiceManager({
      ...deps,
      env: {},
      username: "tester",
      ownerUid: () => undefined,
    });
    const reason = result.available === false ? result.reason : "";
    expect(reason).toContain("user manager is not running for tester");
    expect(reason).toContain("sudo loginctl enable-linger tester");
    expect(reason).toContain("XDG_RUNTIME_DIR=/run/user/1000");
    expect(reason).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus");
  });

  test("macOS always has launchd", async () => {
    const { deps, commands } = fakeServiceDeps({ platform: "darwin" });
    expect(await checkServiceManager(deps)).toEqual({ available: true });
    expect(commands).toEqual([]);
  });
});

describe("userBusEnv", () => {
  const busDeps = (over: WorkerServiceDeps = {}): WorkerServiceDeps => ({
    uid: 1000,
    env: {},
    ownerUid: () => 1000,
    exists: (path) => path === "/run/user/1000/bus",
    ...over,
  });

  test("points systemctl at the user bus when the session did not export it", () => {
    expect(userBusEnv(busDeps())).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  test("leaves an exported XDG_RUNTIME_DIR alone", () => {
    expect(userBusEnv(busDeps({ env: { XDG_RUNTIME_DIR: "/run/user/1000" } }))).toEqual({});
  });

  test("keeps an exported bus address", () => {
    expect(
      userBusEnv(busDeps({ env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom" } })),
    ).toMatchObject({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom" });
  });

  test("ignores a runtime dir owned by someone else, a missing dir, or a missing socket", () => {
    expect(userBusEnv(busDeps({ ownerUid: () => 0 }))).toEqual({});
    expect(userBusEnv(busDeps({ ownerUid: () => undefined }))).toEqual({});
    expect(userBusEnv(busDeps({ exists: () => false }))).toEqual({});
  });
});

describe("installWorkerService on macOS", () => {
  test("bootstraps the agent into the gui domain for the current uid", async () => {
    const plistPath = launchdAgentPath("/Users/tester");
    const { deps, files, commands } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      run: async (command, args) => {
        commands.push([command, ...args]);
        return files.has(plistPath) ? running : inactive;
      },
    });
    const result = await installWorkerService(
      {
        workspaceDir: "/Users/tester/workspace",
        execPath: "/usr/local/bin/devintern",
        runtimePath: "/opt/homebrew/bin/bun",
        environmentPath: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      deps,
    );
    expect(result).toEqual({ ok: true, updated: false });
    const plist = files.get(plistPath) ?? "";
    expect(plist).toContain("<string>/usr/local/bin/devintern</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<string>worker</string>");
    expect(commands).toEqual([
      ["launchctl", "print", "gui/501/com.devintern.worker"],
      ["launchctl", "bootstrap", "gui/501", plistPath],
    ]);
  });

  test("falls back to 'launchctl load -w' when bootstrap is unavailable", async () => {
    const { deps, commands } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "bootstrap") return { ...ok, status: 1 };
        return args[0] === "print" ? running : ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/Users/tester/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(commands).toContainEqual(["launchctl", "load", "-w", launchdAgentPath("/Users/tester")]);
  });

  test("bootouts a loaded agent before updating it", async () => {
    const plistPath = launchdAgentPath("/Users/tester");
    const { deps, commands } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      files: { [plistPath]: managedPlist },
      run: async (command, args) => {
        commands.push([command, ...args]);
        return args[0] === "print" ? running : ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/Users/tester/workspace", execPath: "devintern" },
      deps,
    );
    expect(result).toEqual({ ok: true, updated: true });
    const bootoutAt = commands.findIndex((c) => c[1] === "bootout");
    const bootstrapAt = commands.findIndex((c) => c[1] === "bootstrap");
    expect(bootoutAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(bootoutAt);
  });

  test("does not overwrite an agent when bootout fails", async () => {
    const plistPath = launchdAgentPath("/Users/tester");
    const { deps, files } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      files: { [plistPath]: managedPlist },
      run: async (_command, args) =>
        args[0] === "bootout"
          ? { status: 1, stdout: "", stderr: "Operation not permitted" }
          : running,
    });
    const result = await installWorkerService(
      { workspaceDir: "/Users/tester/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bootout failed");
    expect(files.get(plistPath)).toBe(managedPlist);
  });

  test("refuses to overwrite a custom launchd agent", async () => {
    const plistPath = launchdAgentPath("/Users/tester");
    const { deps, files, commands } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      files: { [plistPath]: "<plist><custom/></plist>" },
    });
    const result = await installWorkerService(
      { workspaceDir: "/Users/tester/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("custom service definition");
    expect(files.get(plistPath)).toContain("<custom/>");
    expect(commands).toEqual([]);
  });

  test("a failed bootstrap restores the previous agent and reloads it", async () => {
    const plistPath = launchdAgentPath("/Users/tester");
    const target = "gui/501/com.devintern.worker";
    const { deps, files, commands } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      files: { [plistPath]: managedPlist },
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (
          (args[0] === "bootstrap" || args[0] === "load") &&
          files.get(plistPath) !== managedPlist
        ) {
          return { status: 1, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        }
        return args[0] === "print" ? running : ok;
      },
    });
    const result = await installWorkerService(
      { workspaceDir: "/Users/tester/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(files.get(plistPath)).toBe(managedPlist);
    expect(commands).toContainEqual(["launchctl", "bootout", target]);
    expect(commands.filter((c) => c[1] === "bootstrap").length).toBeGreaterThanOrEqual(2);
  });

  test("a failed first install leaves no agent behind", async () => {
    const plistPath = launchdAgentPath("/Users/tester");
    const { deps, files } = fakeServiceDeps({
      platform: "darwin",
      homedir: "/Users/tester",
      uid: 501,
      run: async () => ({ status: 127, stdout: "", stderr: "launchd not reachable" }),
    });
    const result = await installWorkerService(
      { workspaceDir: "/Users/tester/workspace", execPath: "devintern" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(files.has(plistPath)).toBe(false);
  });
});

describe("manualServiceInstructions", () => {
  test("lists the Linux enable and linger steps", () => {
    const lines = manualServiceInstructions({
      platform: "linux",
      workspaceDir: "/home/tester/.devintern",
    });
    expect(lines.join("\n")).toContain(
      `cp /home/tester/.devintern/${SYSTEMD_UNIT_NAME} ~/.config/systemd/user/${SYSTEMD_UNIT_NAME}`,
    );
    expect(lines.join("\n")).toContain("systemctl --user enable --now devintern-worker");
    expect(lines.join("\n")).toContain("loginctl enable-linger");
  });

  test("lists the macOS bootstrap step", () => {
    const lines = manualServiceInstructions({
      platform: "darwin",
      workspaceDir: "/Users/tester/.devintern",
    });
    expect(lines.join("\n")).toContain(
      `cp /Users/tester/.devintern/${LAUNCHD_PLIST_NAME} ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}`,
    );
    expect(lines.join("\n")).toContain(
      `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}`,
    );
  });

  test("is empty without a service definition for the platform", () => {
    expect(manualServiceInstructions({ platform: "win32", workspaceDir: "/x" })).toEqual([]);
  });
});

describe("renderers keep self-capture semantics", () => {
  test("systemd unit stays Type=simple without redirects", () => {
    const unit = renderSystemdUnit({ execPath: "devintern", projectDir: "/srv/app" });
    expect(unit).toContain("Type=simple");
    expect(unit).not.toContain("StandardOutput=");
    expect(unit).not.toContain("StandardError=");
  });

  test("systemd unit stops retrying permanent config errors and allows a graceful stop", () => {
    const unit = renderSystemdUnit({ execPath: "devintern", projectDir: "/srv/app" });
    expect(unit).toContain("Restart=on-failure\nRestartSec=30\nRestartPreventExitStatus=78\n");
    expect(unit).toContain("KillMode=mixed\nTimeoutStopSec=120\n");
  });

  test("systemd unit delegates its cgroup for per-job memory limits", () => {
    const unit = renderSystemdUnit({ execPath: "devintern", projectDir: "/srv/app" });
    expect(unit).toContain("Delegate=yes\n");
    expect(unit).toContain("Environment=DEVINTERN_DELEGATED_CGROUP=1\n");
  });

  test("launchd agent keeps RunAtLoad and KeepAlive and logs to its own file", () => {
    const plist = renderLaunchdPlist({ execPath: "devintern", workingDir: "/srv/app" });
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    // Output before self-capture starts still lands somewhere, but not in the
    // capture files the dashboard tails.
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n  <string>/srv/app/worker.launchd.log</string>",
    );
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/srv/app/worker.launchd.log</string>",
    );
    expect(plist).not.toContain("worker.stdout.log");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>30</integer>");
    // launchd exports no identifying variables; the definition must opt the
    // worker into service-manager restarts explicitly, and say it is launchd
    // so a permanent startup failure exits 0 (no RestartPreventExitStatus).
    expect(plist).toContain("<key>DEVINTERN_SERVICE</key>\n    <string>1</string>");
    expect(plist).toContain("<key>DEVINTERN_SERVICE_MANAGER</key>\n    <string>launchd</string>");
  });
});
