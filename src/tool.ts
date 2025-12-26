import { tool as aiTool, type Tool } from "ai";
import { z } from "zod";

export interface ToolContext {
  signal?: AbortSignal;
}

export interface ToolOptions<TInput extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<unknown>;
}

export type { Tool };

export function defineTool<TInput extends z.ZodTypeAny>(
  options: ToolOptions<TInput>
): Tool {
  const { description, schema, handler } = options;

  return aiTool({
    description,
    inputSchema: schema,
    execute: async (input: z.infer<TInput>) => handler(input, {}),
  });
}
