/**
 * About dialog copy and links for PM Desktop.
 */

/** Product name shown in the About title and modal. */
export const ABOUT_PRODUCT_NAME = "DevIntern";

/** Base product label used by the window title and application menu. */
export const APP_DISPLAY_NAME = "DevIntern PM";

/** Build a native window title, omitting the suffix when no usable version is available. */
export function formatAppWindowTitle(version: unknown): string {
  const normalizedVersion = typeof version === "string" ? version.trim() : "";
  return normalizedVersion ? `${APP_DISPLAY_NAME} v${normalizedVersion}` : APP_DISPLAY_NAME;
}

/**
 * Public homepage opened from About. UTM tags match other pm-desktop surfaces
 * (e.g. code discovery) so desktop referral traffic stays attributable.
 */
export const ABOUT_WEBSITE_URL = "https://devintern.com/?utm_source=pm-desktop&utm_campaign=about";
