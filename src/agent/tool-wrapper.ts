import type { Tool } from "ai";
import type { Logger } from "../types.js";

export interface ToolCallbacks {
  onToolCall?: (name: string, input: unknown) => void | Promise<void>;
  onToolResult?: (name: string, result: unknown) => void | Promise<void>;
  onError?: (
    error: Error,
    context: { phase: "tool" | "api" | "timeout"; toolName?: string }
  ) => void | Promise<void>;
}

export function wrapToolsWithCallbacks(
  tools: Record<string, Tool>,
  timings: Map<string, number>,
  logger: Logger | undefined,
  callbacks: ToolCallbacks
): Record<string, Tool> {
  const { onToolCall, onToolResult, onError } = callbacks;
  const wrapped: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }

    const originalExecute = tool.execute;

    wrapped[name] = {
      ...tool,
      execute: async (
        args: Parameters<typeof originalExecute>[0],
        execOptions: Parameters<typeof originalExecute>[1]
      ) => {
        const toolCallId = execOptions?.toolCallId ?? "";
        const start = Date.now();

        logger?.debug(`Tool call: ${name}`, { input: args });
        await onToolCall?.(name, args);

        try {
          const result = await originalExecute(args, execOptions);
          logger?.debug(`Tool result: ${name}`, { durationMs: Date.now() - start });
          await onToolResult?.(name, result);

          timings.set(toolCallId, Date.now() - start);
          return result;
        } catch (error) {
          const errorObj = error instanceof Error ? error : new Error(String(error));
          logger?.error(`Tool error: ${name}`, { error: errorObj.message });
          await onError?.(errorObj, { phase: "tool", toolName: name });
          throw error;
        }
      },
    };
  }

  return wrapped;
}
