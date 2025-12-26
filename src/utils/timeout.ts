export function createTimeoutSignal(timeoutMs: number, existingSignal?: AbortSignal): AbortSignal {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  if (existingSignal) {
    if (existingSignal.aborted) {
      clearTimeout(timer);
      controller.abort(existingSignal.reason);
    } else {
      existingSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.abort(existingSignal.reason);
      });
    }
  }

  controller.signal.addEventListener("abort", () => clearTimeout(timer));

  return controller.signal;
}
