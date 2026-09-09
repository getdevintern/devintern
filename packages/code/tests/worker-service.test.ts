import { describe, test, expect } from "bun:test";

import {
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
} from "../src/lib/worker-service";
import type { RunCommandFn, WorkerServiceDeps } from "../src/lib/worker-service";

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
      deps,
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
      ["systemctl", "--user", "enable", "--now", "devintern-worker"],
      ["systemctl", "--user", "is-active", "devintern-worker"],
      ["loginctl", "enable-linger"],
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
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("may stop at logout");
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
      ["launchctl", "print", "gui/501/com.devintern.worker"],
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

  test("launchd agent keeps RunAtLoad and KeepAlive without redirects", () => {
    const plist = renderLaunchdPlist({ execPath: "devintern", workingDir: "/srv/app" });
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).not.toContain("StandardOutPath");
    // launchd exports no identifying variables; the definition must opt the
    // worker into service-manager restarts explicitly.
    expect(plist).toContain("<key>DEVINTERN_SERVICE</key>");
    expect(plist).toContain("<string>1</string>");
  });
});
