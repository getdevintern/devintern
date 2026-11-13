/**
 * Markers delimiting the agent's final implementation briefing.
 *
 * Producers (the implementation/repair prompt) and consumers (the incomplete
 * detector, the code package's summary extractor) must agree on these exact
 * literals, so they live in the shared harness package rather than being
 * duplicated per caller.
 */
export const IMPLEMENTATION_SUMMARY_START = "<!-- devintern:summary:start -->";
export const IMPLEMENTATION_SUMMARY_END = "<!-- devintern:summary:end -->";
