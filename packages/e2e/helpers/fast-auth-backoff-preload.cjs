// Bun `--preload` for one CLI child: collapses supabase-js's token-refresh
// backoff sleeps so an unreachable Supabase fails in milliseconds instead of
// ~25 s. On a retryable network error, `_refreshAccessToken`
// (@supabase/auth-js GoTrueClient) sleeps 200 ms * 2^n between attempts until
// the next backoff would overflow its 30 s tick. Those sleeps go through the
// global `setTimeout` (auth-js `sleep`), so timers whose delay is exactly one
// of those backoff steps fire on the next turn instead. Every refresh attempt
// still runs and still reaches the recording proxy; only the waiting between
// them is skipped. Because the clock itself is not moved, the loop stops one
// step later (the 25.6 s step also collapses), which adds one attempt.
// Only processes started with `--preload` load this file.
const BACKOFF_DELAYS_MS = new Set(Array.from({ length: 8 }, (_, step) => 200 * 2 ** step));

const setTimeoutOriginal = globalThis.setTimeout;
globalThis.setTimeout = function (callback, delay, ...args) {
  const collapsed = BACKOFF_DELAYS_MS.has(delay) ? 0 : delay;
  return setTimeoutOriginal.call(this, callback, collapsed, ...args);
};
