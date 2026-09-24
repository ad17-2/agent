import type { BackoffStrategy } from "../types.js";

export function calculateBackoff(
  attempt: number,
  strategy: BackoffStrategy,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  let delay: number;
  switch (strategy) {
    case "fixed":
      delay = initialDelayMs;
      break;
    case "linear":
      delay = initialDelayMs * attempt;
      break;
    case "exponential":
      delay = initialDelayMs * Math.pow(2, attempt - 1);
      break;
  }
  return Math.min(delay, maxDelayMs);
}

/** Resolves after `ms`, or rejects with `signal.reason` as soon as the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
