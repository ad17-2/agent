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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
