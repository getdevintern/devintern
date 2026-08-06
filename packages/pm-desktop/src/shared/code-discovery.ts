/**
 * Soft discovery for @devintern/code from PM Desktop.
 *
 * Shown in the ticket sidebar footer, after a successful create, and on the
 * no-tickets empty state when the project is configured, the team has not
 * already set up Code, and the user has not dismissed it. Dismissal is stored
 * in userData settings and persists across sessions.
 */

/** Outcome-first Code landing (founders page) with desktop UTM tags. */
export const CODE_PRODUCT_URL =
  "https://devintern.com/for/founders/?utm_source=pm-desktop&utm_campaign=code-discovery";

export interface CodeDiscoveryVisibilityInput {
  /** Project has usable PM config (setup banner takes priority otherwise). */
  configured: boolean;
  /** Project already has a `.devintern-code` directory. */
  hasCodeConfig: boolean;
  /** User chose "Don't show again" (persisted in settings.json). */
  dismissed: boolean;
}

/** Whether the Code discovery tip should render. */
export function shouldShowCodeDiscovery(input: CodeDiscoveryVisibilityInput): boolean {
  return input.configured && !input.hasCodeConfig && !input.dismissed;
}
