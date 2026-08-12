/**
 * Bound-store helper for the desktop PM app.
 *
 * The app runs in Electron (client-only), so there is no real SSR. But the
 * component tests render with `renderToStaticMarkup`, which is React's server
 * path. Zustand v5's built-in `useStore` passes `api.getInitialState()` as the
 * server snapshot — so SSR reads the *initial* state and ignores any
 * `setState` a test uses to seed the store. That makes store-backed components
 * render as empty in tests.
 *
 * This helper builds the store with `createStore` (vanilla) and binds a hook
 * that passes `getState()` as BOTH the client and server snapshots, so
 * `renderToStaticMarkup` reads the current (seeded) state. The returned hook
 * keeps the `useStore(selector)` ergonomics and carries the vanilla api
 * (`getState` / `setState` / `subscribe`) as properties, like `zustand`'s
 * `create`.
 */

import { useSyncExternalStore } from "react";
import { createStore as createVanillaStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

export type BoundStore<T> = {
  /**
   * Subscribe to a slice of the store. The selector MUST return a stable
   * reference — a primitive, or a value taken directly from state (e.g. an
   * existing object/array field). Returning a freshly-allocated object/array
   * (e.g. `useStore((s) => ({ a: s.a }))`) will create a new reference on
   * every snapshot read and trigger an infinite re-render loop, because
   * `useSyncExternalStore` compares snapshots with `Object.is`. For derived
   * object/array slices, compute them outside the hook or add a shallow-equal
   * layer.
   */
  <U>(selector: (state: T) => U): U;
  getState: StoreApi<T>["getState"];
  setState: StoreApi<T>["setState"];
  subscribe: StoreApi<T>["subscribe"];
  getInitialState: StoreApi<T>["getInitialState"];
};

export function createBoundStore<T>(
  initializer: (set: StoreApi<T>["setState"]) => T,
): BoundStore<T> {
  const api = createVanillaStore(initializer);
  const useBoundStore = <U>(selector: (state: T) => U): U =>
    useSyncExternalStore(
      api.subscribe,
      () => selector(api.getState()),
      () => selector(api.getState()),
    );
  // Attach the vanilla api to the hook (mirrors zustand's `create`).
  const bound = useBoundStore as unknown as BoundStore<T>;
  (bound as { getState: StoreApi<T>["getState"] }).getState = api.getState;
  (bound as { setState: StoreApi<T>["setState"] }).setState = api.setState;
  (bound as { subscribe: StoreApi<T>["subscribe"] }).subscribe = api.subscribe;
  (bound as { getInitialState: StoreApi<T>["getInitialState"] }).getInitialState =
    api.getInitialState;
  return bound;
}
