import type { Tool, ToolSet } from "ai";
import type { DefinedTool } from "../tool.js";
import type { AgentHooks, Logger, TimeoutConfig } from "../types.js";

type ExecuteFn = NonNullable<Tool["execute"]>;
type ExecuteOptions = Parameters<ExecuteFn>[1];

export function wrapToolsWithCallbacks(
  tools: ToolSet,
  logger: Logger | undefined,
  callbacks: Pick<AgentHooks, "onToolCall" | "onToolResult" | "onError">,
  timeoutConfig?: TimeoutConfig
): ToolSet {
  const { onToolCall, onToolResult, onError } = callbacks;
  const wrapped: ToolSet = {};

  for (const [name, tool] of Object.entries<DefinedTool>(tools)) {
    const originalExecute = tool.execute;
    if (!originalExecute) {
      wrapped[name] = tool;
      continue;
    }

    const toolTimeoutMs = tool.timeoutMs ?? timeoutConfig?.toolMs;

    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, execOptions: ExecuteOptions) => {
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
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error(String(signal.reason))
                  );
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
              }),
            ])
          : execution;

        try {
          const result = await resultPromise;
          logger?.debug(`Tool result: ${name}`, { durationMs: Date.now() - start });
          await onToolResult?.(name, result);
          return result;
        } catch (error) {
          const errorObj = error instanceof Error ? error : new Error(String(error));
          // Cut off by the run's own signal (timeout or abort): the run reports that once, not the tool.
          // A tool that fails with its own error at the same moment is still reported.
          const runSignal = execOptions?.abortSignal;
          const cutOffByRun =
            runSignal?.aborted === true &&
            (error === runSignal.reason || errorObj.name === "AbortError");
          if (!cutOffByRun) {
            logger?.error(`Tool error: ${name}`, { error: errorObj.message });
            await onError?.(errorObj, { phase: "tool", toolName: name });
          }
          throw errorObj;
        }
      },
    };
  }

  return wrapped;
}
