import type { SignalState } from "../agent/stop-reason.js";

export interface RunSignal {
  signal: AbortSignal;
  /** Which source fired: the run timer, or the caller's signal / `cancel()`. */
  state(): SignalState;
  /** Aborts the run from inside the package (e.g. the consumer stopped iterating a stream). */
  cancel(): void;
  /** Clears the run timer; call on every exit path. */
  dispose(): void;
}

export function createRunSignal(
  timeoutMs: number | undefined,
  callerSignal?: AbortSignal
): RunSignal {
  const timeout = new AbortController();
  const cancel = new AbortController();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            timeout.abort(new DOMException(`Run timed out after ${timeoutMs}ms`, "TimeoutError")),
          timeoutMs
        );

  const sources = [timeout.signal, cancel.signal];
  if (callerSignal) sources.push(callerSignal);
  const signal = AbortSignal.any(sources);

  return {
    signal,
    // AbortSignal.any adopts the reason of whichever source fired first, so identity tells them apart.
    state: () =>
      !signal.aborted ? undefined : signal.reason === timeout.signal.reason ? "timeout" : "aborted",
    cancel: () => cancel.abort(),
    dispose: () => clearTimeout(timer),
  };
}
