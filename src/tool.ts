import { tool as aiTool, type Tool } from "ai";
import type { z } from "zod";

export interface ToolContext {
  signal?: AbortSignal;
  toolCallId?: string;
}

export interface ToolErrorContext<TInput = unknown> {
  error: Error;
  input: TInput;
  toolCallId?: string;
}

export interface ToolOptions<TInput extends z.ZodType> {
  description: string;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<unknown>;
  onError?: (context: ToolErrorContext<z.infer<TInput>>) => unknown;
  /** Per-tool timeout; enforced by agent/tool-wrapper.ts, not here. */
  timeoutMs?: number;
}

export type DefinedTool = Tool & { timeoutMs?: number };

export type { Tool };

export function defineTool<TInput extends z.ZodType>(options: ToolOptions<TInput>): DefinedTool {
  const { description, schema, handler, onError, timeoutMs } = options;

  const built: DefinedTool = aiTool({
    description,
    inputSchema: schema,
    execute: async (input: z.infer<TInput>, execOptions) => {
      const context: ToolContext = {
        signal: execOptions?.abortSignal,
        toolCallId: execOptions?.toolCallId,
      };

      try {
        return await handler(input, context);
      } catch (error) {
        if (onError) {
          const errorContext: ToolErrorContext<z.infer<TInput>> = {
            error: error instanceof Error ? error : new Error(String(error)),
            input,
            toolCallId: execOptions?.toolCallId,
          };
          return await onError(errorContext);
        }
        throw error;
      }
    },
  });

  built.timeoutMs = timeoutMs;
  return built;
}
