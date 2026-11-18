// Bun `--preload` for one CLI child: answers `/proc/self/cgroup` reads with
// E2E_FAKE_CGROUP so `isAutomatedEnvironment`
// (packages/code/src/lib/config/env-detector.ts) sees a chosen systemd unit
// instead of the host's. The bundled CLI imports `readFileSync` from "fs", and
// Bun's ESM bindings for builtins follow this CommonJS object, so the patch
// reaches it. Only processes started with `--preload` load this file.
const fs = require("node:fs");

const fake = process.env.E2E_FAKE_CGROUP;
if (fake === undefined) throw new Error("fake-cgroup-preload needs E2E_FAKE_CGROUP");
const readFileSync = fs.readFileSync;
fs.readFileSync = function (path, ...rest) {
  if (path === "/proc/self/cgroup") return fake;
  return readFileSync.call(this, path, ...rest);
};
