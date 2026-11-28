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

/** DOM id of the Automations view's Source health section. */
export const SOURCE_HEALTH_SECTION_ID = "source-health";

let pendingSourceHealthFocus = false;

/** Reveal the Source health section now, or as soon as Automations mounts it. */
export function requestSourceHealthFocus(): void {
  if (!revealElement(SOURCE_HEALTH_SECTION_ID)) pendingSourceHealthFocus = true;
}

/** Called by the Source health section on mount; reveals it when a request is pending. */
export function consumeSourceHealthFocus(): void {
  if (!pendingSourceHealthFocus) return;
  pendingSourceHealthFocus = false;
  revealElement(SOURCE_HEALTH_SECTION_ID);
}

/** DOM id of one row in the Overview's Queued list. */
export function queuedItemDomId(itemId: string): string {
  return `aq-item-${itemId}`;
}

/** A request the list never fulfils (the item was claimed meanwhile) lapses after this. */
const QUEUED_FOCUS_TTL_MS = 30_000;

let pendingQueuedFocus: { itemId: string; at: number } | null = null;

/** Open the Queued disclosure and the row, then reveal it; false when it is not rendered. */
function revealQueuedItem(itemId: string): boolean {
  const id = queuedItemDomId(itemId);
  const row = document.getElementById(id);
  if (!row) return false;
  row.querySelector("details")?.setAttribute("open", "");
  for (
    let parent = row.closest("details");
    parent;
    parent = parent.parentElement?.closest("details") ?? null
  ) {
    parent.setAttribute("open", "");
  }
  return revealElement(id);
}

/** Reveal a queued item now, or once the Overview's Queued list renders it. */
export function requestQueuedFocus(itemId: string): void {
  pendingQueuedFocus = revealQueuedItem(itemId) ? null : { itemId, at: Date.now() };
}

/** Called by the Queued list after it renders; reveals a pending item once it is listed. */
export function consumeQueuedFocus(): void {
  if (pendingQueuedFocus === null) return;
  if (Date.now() - pendingQueuedFocus.at > QUEUED_FOCUS_TTL_MS) {
    pendingQueuedFocus = null;
    return;
  }
  if (revealQueuedItem(pendingQueuedFocus.itemId)) pendingQueuedFocus = null;
}
