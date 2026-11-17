import type { Window } from "happy-dom";

/**
 * Repair happy-dom's `Node.prototype.nodeName` for DOMPurify.
 *
 * happy-dom declares `nodeName` on `Node.prototype` as a stub that always
 * returns `""` and overrides it per concrete class (`Element`, `Text`, ...).
 * DOMPurify 3.4+ resolves the `Node.prototype.nodeName` getter once from the
 * window it is bound to and calls it for every node, so under happy-dom every
 * element reads as an empty tag name: allowed tags get unwrapped and forbidden
 * content (for example `<script>` text) survives. Sanitization then fails open
 * without throwing, which reads as a broken component instead of a DOM quirk.
 *
 * Chromium, the renderer's real DOM, implements `nodeName` on
 * `Node.prototype` itself, so only tests are affected. Delegate to the
 * concrete class implementation to give DOMPurify a spec-compliant view.
 */
export function fixHappyDomNodeName(domWindow: Window): void {
  const nodePrototype = (domWindow as unknown as { Node: { prototype: object } }).Node.prototype;
  const original = Object.getOwnPropertyDescriptor(nodePrototype, "nodeName");

  Object.defineProperty(nodePrototype, "nodeName", {
    configurable: true,
    enumerable: original?.enumerable ?? false,
    get(this: object): string {
      let prototype = Object.getPrototypeOf(this) as object | null;
      while (prototype && prototype !== nodePrototype) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "nodeName");
        if (typeof descriptor?.get === "function") {
          return descriptor.get.call(this) as string;
        }
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
      return (original?.get?.call(this) as string | undefined) ?? "";
    },
  });
}
