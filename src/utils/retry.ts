import { APICallError, StreamProviderError, type LanguageModelMiddleware } from "ai";
import type { RetryConfig } from "../types.js";
import { calculateBackoff, sleep } from "./async.js";

export interface RetryOptions extends Required<RetryConfig> {
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

/** The SDK's own signal: an error the provider classified says so itself; otherwise only a failed connection or a timed-out request. */
export function isRetryableError(error: Error): boolean {
  if (APICallError.isInstance(error) || StreamProviderError.isInstance(error)) {
    return error.isRetryable;
  }
  return (
    error.name === "TimeoutError" ||
    (error.name === "TypeError" && error.message === "fetch failed")
  );
}

type WrapStreamOptions = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamResult = Awaited<ReturnType<WrapStreamOptions["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** A provider's stream `error` part carries a plain `{ message, statusCode, isRetryable }` object; keep its classification. */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new StreamProviderError({
      message: error.message,
      type: "type" in error && typeof error.type === "string" ? error.type : undefined,
      statusCode:
        "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : undefined,
      isRetryable:
        "isRetryable" in error && typeof error.isRetryable === "boolean"
          ? error.isRetryable
          : undefined,
      data: error,
    });
  }
  return new Error(String(error));
}

/** Sleeps before the next attempt, or rethrows `error` when no attempt is allowed. Never sleeps once `signal` has fired. */
async function backoffOrThrow(
  error: unknown,
  attempt: number,
  signal: AbortSignal | undefined,
  options: RetryOptions
): Promise<void> {
  const err = toError(error);
  if (signal?.aborted || attempt >= options.maxAttempts || !options.retryOn(err)) throw error;

  const delayMs = calculateBackoff(
    attempt,
    options.backoff,
    options.initialDelayMs,
    options.maxDelayMs
  );
  options.logger?.(`Attempt ${attempt} failed, retrying in ${delayMs}ms`, { error: err.message });
  await sleep(delayMs, signal);
}

/**
 * Reads past `stream-start` so a failure before any content (a rejected read or an `error` part)
 * surfaces as a throw the caller can retry. On success the consumed parts are put back in front.
 */
async function openStream(result: StreamResult): Promise<StreamResult> {
  const reader = result.stream.getReader();
  const buffered: StreamPart[] = [];
  let done = false;

  while (!done) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    if (next.value.type === "error") throw next.value.error;
    buffered.push(next.value);
    if (next.value.type !== "stream-start") break;
  }

  return {
    ...result,
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of buffered) controller.enqueue(part);
        if (done) controller.close();
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
  };
}

/**
 * Retries a single model call. `doGenerate` is retried whole; `doStream` only while nothing past
 * `stream-start` has been delivered, since replaying would duplicate output the consumer already saw.
 */
export function retryMiddleware(options: RetryOptions): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",

    wrapGenerate: async ({ doGenerate, params }) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await doGenerate();
        } catch (error) {
          await backoffOrThrow(error, attempt, params.abortSignal, options);
        }
      }
    },

    wrapStream: async ({ doStream, params }) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await openStream(await doStream());
        } catch (error) {
          await backoffOrThrow(error, attempt, params.abortSignal, options);
        }
      }
    },
  };
}
