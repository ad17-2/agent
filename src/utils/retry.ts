import { AgentError } from "../errors.js";
import type { RetryConfig } from "../types.js";
import { calculateBackoff, sleep } from "./async.js";

export interface RetryOptions extends Required<RetryConfig> {
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  signal?: AbortSignal
): Promise<T> {
  const { maxAttempts, backoff, initialDelayMs, maxDelayMs, retryOn, logger } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new AgentError("Request was aborted", "ABORTED");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        break;
      }

      if (!retryOn(lastError)) {
        throw lastError;
      }

      const delayMs = calculateBackoff(attempt, backoff, initialDelayMs, maxDelayMs);
      logger?.(`Attempt ${attempt} failed, retrying in ${delayMs}ms`, {
        error: lastError.message,
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}
