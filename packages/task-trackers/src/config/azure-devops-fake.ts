/**
 * Guarded test seam that points Azure DevOps clients at the offline e2e fake.
 *
 * `AZURE_DEVOPS_BASE_URL` is honored only when the process opted in with
 * `DEVINTERN_E2E_FAKE_AZURE_DEVOPS=1` and only for a loopback http(s) URL, so
 * a project or team env file can never redirect a PAT to another host.
 */

/**
 * The opt-in, captured at module load: before any CLI loads project env
 * files into `process.env`, so those files cannot turn the seam on.
 */
export const AZURE_DEVOPS_FAKE_OPT_IN = process.env.DEVINTERN_E2E_FAKE_AZURE_DEVOPS === "1";

const INVALID = "AZURE_DEVOPS_BASE_URL must be an absolute loopback http(s) URL";

/**
 * Resolve the fake base URL to pass as `AzureDevOpsClient`'s `baseUrl`.
 *
 * @param raw - The `AZURE_DEVOPS_BASE_URL` value from the tracker env.
 * @param allowFake - Whether the process opted in (defaults to the captured opt-in).
 * @returns The normalized loopback URL, or `undefined` (production) when not opted in or unset.
 * @throws When opted in and the value is not an absolute loopback http(s) URL.
 */
export function azureDevOpsFakeBaseUrl(
  raw: string | undefined,
  allowFake: boolean = AZURE_DEVOPS_FAKE_OPT_IN,
): string | undefined {
  if (!allowFake || !raw?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(INVALID);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(INVALID);
  }
  return url.toString().replace(/\/+$/, "");
}
