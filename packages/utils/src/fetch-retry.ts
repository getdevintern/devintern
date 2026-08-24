const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("econnrefused") ||
    message.includes("econnaborted") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    message.includes("unable to connect") ||
    message.includes("unable to resolve") ||
    message.includes("getaddrinfo") ||
    // libcurl/Bun DNS and connect failures surface as
    // "Failed to connect to ... Was there a typo in the url or port?"
    message.includes("typo in the url or port") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket hang up") ||
    message.includes("epipe") ||
    message.includes("timed out")
  );
}

/**
 * Default retry count. `DEVINTERN_FETCH_MAX_RETRIES=0` disables retries so
 * tests can fail immediately instead of sleeping through backoff against a
 * fake tracker host.
 */
function defaultMaxRetries(): number {
  const raw = process.env.DEVINTERN_FETCH_MAX_RETRIES;
  if (raw === undefined || raw === "") {
    return 3;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 3;
  }
  return parsed;
}

/**
 * Fetch with exponential backoff retry for transient failures.
 * Automatically retries on network errors and retryable HTTP status codes.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (method, headers, body, etc.)
 * @param retryOptions - Retry configuration
 * @returns The fetch Response object
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryOptions?: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    jitter?: boolean;
    verbose?: boolean;
  },
): Promise<Response> {
  const maxRetries = retryOptions?.maxRetries ?? defaultMaxRetries();
  const baseDelay = retryOptions?.baseDelay ?? 1000;
  const maxDelay = retryOptions?.maxDelay ?? 30000;
  const jitter = retryOptions?.jitter ?? true;
  const verbose = retryOptions?.verbose ?? false;

  let lastError: Error | null = null;
  let failedAttempts = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const response = await fetch(url, options);

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        failedAttempts++;

        if (attempt > maxRetries) {
          return response;
        }

        const retryAfter = response.headers.get("Retry-After");
        let delay: number;

        if (retryAfter) {
          const seconds = Number.parseInt(retryAfter, 10);
          if (!Number.isNaN(seconds)) {
            delay = seconds * 1000;
          } else {
            const date = new Date(retryAfter);
            delay = Math.max(0, date.getTime() - Date.now());
          }
        } else {
          delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
          if (jitter) {
            delay = delay + Math.random() * delay * 0.5;
          }
        }

        if (verbose) {
          console.warn(
            `⚠️  HTTP ${response.status} from ${url}, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries + 1})...`,
          );
        }
        await sleep(delay);
        continue;
      }

      if (verbose && failedAttempts > 0) {
        console.log(
          `✅ Request to ${url} succeeded on attempt ${attempt}/${maxRetries + 1} (after ${failedAttempts} ${failedAttempts === 1 ? "retry" : "retries"})`,
        );
      }
      return response;
    } catch (error) {
      lastError = error as Error;
      failedAttempts++;

      if (!isRetryableNetworkError(lastError)) {
        throw lastError;
      }

      if (attempt > maxRetries) {
        throw lastError;
      }

      let delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      if (jitter) {
        delay = delay + Math.random() * delay * 0.5;
      }

      if (verbose) {
        console.warn(
          `⚠️  Network error (${lastError.message}), retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries + 1})...`,
        );
      }
      await sleep(delay);
    }
  }

  throw lastError || new Error("Unexpected retry loop exit");
}
