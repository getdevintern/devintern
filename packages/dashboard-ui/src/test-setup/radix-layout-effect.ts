/**
 * Test preload (see `bunfig.toml`): load Radix while a DOM document exists.
 *
 * `@radix-ui/react-use-layout-effect` picks React's `useLayoutEffect` or a
 * no-op once, at import time, by checking `globalThis.document`. Interaction
 * tests create their happy-dom document per test, after Radix is already
 * loaded, so portals and `Presence` (dialogs, popovers) would never mount.
 * Importing Radix here with a temporary document fixes that choice; the
 * global is removed again so server-render tests see no DOM.
 */

import { Window } from "happy-dom";

const hadDocument = "document" in globalThis;
const window = new Window();
if (!hadDocument) globalThis.document = window.document as unknown as Document;
await import("radix-ui");
if (!hadDocument) {
  // @ts-expect-error restoring the server-render environment
  delete globalThis.document;
}
await window.happyDOM.close();
