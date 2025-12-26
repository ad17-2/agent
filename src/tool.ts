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

export interface ToolOptions<TInput extends z.ZodTypeAny> {
  description: string;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<unknown>;
  onError?: (context: ToolErrorContext<z.infer<TInput>>) => unknown | Promise<unknown>;
  timeoutMs?: number;
}

export type { Tool };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function defineTool<TInput extends z.ZodTypeAny>(options: ToolOptions<TInput>): Tool {
  const { description, schema, handler, onError, timeoutMs } = options;

  return aiTool({
    description,
    inputSchema: schema,
    execute: async (input: z.infer<TInput>, execOptions) => {
      const context: ToolContext = {
        signal: execOptions?.abortSignal,
        toolCallId: execOptions?.toolCallId,
      };

      try {
        let resultPromise = handler(input, context);

        if (timeoutMs) {
          resultPromise = withTimeout(resultPromise, timeoutMs, description);
        }

        return await resultPromise;
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
}
