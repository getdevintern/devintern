/**
 * Test setup guard, preloaded via `bunfig.toml` (and the root `bunfig.toml`).
 *
 * Inside a DevIntern agent run the worker exports `DEVINTERN_RUN_ID` and
 * `DEVINTERN_RUN_OUTPUTS`; every engine `createTask` in a test would then
 * append a stub ticket to that run's outputs file and show up as spawned work.
 * Tests that exercise recording pass an explicit env instead.
 */

import { RUN_ID_ENV, RUN_OUTPUTS_ENV } from "./lib/run-outputs.js";

delete process.env[RUN_ID_ENV];
delete process.env[RUN_OUTPUTS_ENV];
