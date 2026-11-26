/** Default dashboard port when neither `dashboard_port` nor `DASHBOARD_PORT` is set. */
export const DEFAULT_DASHBOARD_PORT = 4400;

/** The port the dashboard listens on: workspace setting, then `DASHBOARD_PORT`, then the default. */
export function resolveDashboardPort(
  configPort: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  return configPort ?? (Number.parseInt(env.DASHBOARD_PORT || "", 10) || DEFAULT_DASHBOARD_PORT);
}
