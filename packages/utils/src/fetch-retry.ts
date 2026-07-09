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
    message.includes("enotfound") ||
    message.includes("unable to connect") ||
    message.includes("network") ||
    message.includes("socket hang up") ||
    message.includes("epipe")
  );
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
  const maxRetries = retryOptions?.maxRetries ?? 3;
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
