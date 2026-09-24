import type { Tool, ToolSet } from "ai";
import type { Logger, TimeoutConfig } from "../types.js";

export interface ToolCallbacks {
  onToolCall?: (name: string, input: unknown) => void | Promise<void>;
  onToolResult?: (name: string, result: unknown) => void | Promise<void>;
  onError?: (
    error: Error,
    context: { phase: "tool" | "api" | "timeout"; toolName?: string }
  ) => void | Promise<void>;
}

type ExecuteFn = NonNullable<Tool["execute"]>;
type ExecuteOptions = Parameters<ExecuteFn>[1];

/** The only tool wrapper in the codebase: enforces the timeout, runs hooks, and tracks call duration. */
export function wrapToolsWithCallbacks(
  tools: ToolSet,
  timings: Map<string, number>,
  logger: Logger | undefined,
  callbacks: ToolCallbacks,
  timeoutConfig?: TimeoutConfig
): ToolSet {
  const { onToolCall, onToolResult, onError } = callbacks;
  const wrapped: ToolSet = {};

  for (const [name, tool] of Object.entries(tools)) {
    const originalExecute = tool.execute;
    if (!originalExecute) {
      wrapped[name] = tool;
      continue;
    }

    const toolTimeoutMs = (tool as { timeoutMs?: number }).timeoutMs ?? timeoutConfig?.toolTimeoutMs;

    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, execOptions: ExecuteOptions) => {
        const toolCallId = execOptions?.toolCallId ?? "";
        const start = Date.now();

        logger?.debug(`Tool call: ${name}`, { input: args });
        await onToolCall?.(name, args);

        const signals: AbortSignal[] = [];
        if (execOptions?.abortSignal) signals.push(execOptions.abortSignal);
        if (toolTimeoutMs) signals.push(AbortSignal.timeout(toolTimeoutMs));
        const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

        // The handler is aborted via `signal` so it can react immediately, but a handler
        // that never checks its signal must still not hang the run forever: once `signal`
        // fires, give up on the call rather than wait for it indefinitely.
        const execution = originalExecute(args, { ...execOptions, abortSignal: signal });
        execution.catch(() => {}); // avoid an unhandled rejection if the timeout race wins first
        const resultPromise = signal
          ? Promise.race([
              execution,
              new Promise<never>((_resolve, reject) => {
                const abort = () =>
                  reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
              }),
            ])
          : execution;

        try {
          const result = await resultPromise;
          logger?.debug(`Tool result: ${name}`, { durationMs: Date.now() - start });
          await onToolResult?.(name, result);

          timings.set(toolCallId, Date.now() - start);
          return result;
        } catch (error) {
          const errorObj = error instanceof Error ? error : new Error(String(error));
          timings.set(toolCallId, Date.now() - start);
          logger?.error(`Tool error: ${name}`, { error: errorObj.message });
          await onError?.(errorObj, { phase: "tool", toolName: name });
          throw errorObj;
        }
      },
    };
  }

  return wrapped;
}
