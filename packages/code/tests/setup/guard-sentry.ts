/**
 * Test setup guard — preloaded before every test via `bunfig.toml`.
 *
 * Pins `SENTRY_DISABLED=1` so the test suite and every CLI subprocess it
 * spawns (tests run `src/index.ts` with an inherited `{ ...process.env }`)
 * never report events to the baked-in production Sentry DSN. Without this,
 * expected user-input validation failures exercised by tests (e.g. the
 * markdown client's "File is empty" / "File not found" error paths, see
 * markdown-file.test.ts) ship as error-level Sentry events from CI, creating
 * noise issues like DEVINTERN-7.
 *
 * The override is unconditional (mirroring guard-queue-db.ts): a value
 * inherited from the developer's shell is not trusted. Tests that need Sentry
 * initialized must explicitly restore `process.env.SENTRY_DISABLED` around the
 * relevant code path.
 */

process.env.SENTRY_DISABLED = "1";
