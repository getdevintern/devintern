/**
 * Compatibility re-export.
 *
 * The centralized untrusted-content framing lives alongside the prompt catalog
 * in `../prompts/untrusted-content`; this shim keeps the historical
 * `lib/prompt/untrusted-content` import path working.
 */
export * from "../prompts/untrusted-content";
