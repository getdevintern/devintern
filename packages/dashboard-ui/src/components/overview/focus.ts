/**
 * Cross-view focus requests for the Overview: the status-strip harness pill
 * can be clicked from any page, but the harness section only exists once the
 * Overview has loaded its data. A pending request is consumed on mount.
 */

/** DOM id of the Overview's agent-harness section. */
export const HARNESS_SECTION_ID = "ov-harnesses";

let pendingHarnessFocus = false;

/** Scroll an element into view and move keyboard focus to it. */
export function revealElement(id: string): boolean {
  const element = document.getElementById(id);
  if (!element) return false;
  element.scrollIntoView({ block: "start", behavior: "smooth" });
  element.focus({ preventScroll: true });
  // Mouse users get a brief highlight instead of a focus ring that lingers
  // until blur; keyboard users still get :focus-visible.
  element.classList.remove("ov-reveal");
  void element.offsetWidth; // restart the animation on repeat clicks
  element.classList.add("ov-reveal");
  window.setTimeout(() => element.classList.remove("ov-reveal"), 1600);
  return true;
}

/** Reveal the harness section now, or as soon as the Overview mounts it. */
export function requestHarnessFocus(): void {
  if (!revealElement(HARNESS_SECTION_ID)) pendingHarnessFocus = true;
}

/** Called by the harness section on mount; reveals it when a request is pending. */
export function consumeHarnessFocus(): void {
  if (!pendingHarnessFocus) return;
  pendingHarnessFocus = false;
  revealElement(HARNESS_SECTION_ID);
}
