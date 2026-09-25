import { tool as aiTool, dynamicTool, jsonSchema, type Tool, type ToolExecutionOptions } from "ai";
import type { z } from "zod";

export interface ToolContext {
  abortSignal?: AbortSignal;
  toolCallId?: string;
}

export interface ToolErrorContext<TInput = unknown> {
  error: Error;
  input: TInput;
  toolCallId?: string;
}

/** What `toModelOutput` returns: the tool result as the model sees it. */
export type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;

// The SDK's own spelling of a tool's input in its hooks; equal to z.infer for any real schema.
type HookInput<TInput extends z.ZodType> = [z.infer<TInput>] extends [never]
  ? unknown
  : z.infer<TInput>;

export interface ToolOptions<TInput extends z.ZodType> {
  description: string;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<unknown>;
  onError?: (context: ToolErrorContext<z.infer<TInput>>) => unknown;
  /** Per-tool timeout; enforced by agent/tool-wrapper.ts, not here. */
  timeoutMs?: number;
  /** Maps the handler's result to what the model sees; the run's records keep the raw result. */
  toModelOutput?: (
    output: unknown,
    context: { toolCallId: string; input: HookInput<TInput> }
  ) => ToolResultOutput;
  onInputStart?: (context: ToolContext) => void | Promise<void>;
  /** Streaming runs only. */
  onInputDelta?: (delta: string, context: ToolContext) => void | Promise<void>;
  onInputAvailable?: (input: HookInput<TInput>, context: ToolContext) => void | Promise<void>;
}

export interface DynamicToolOptions {
  description: string;
  handler: (input: unknown, context: ToolContext) => Promise<unknown>;
  onError?: (context: ToolErrorContext) => unknown;
  /** Per-tool timeout; enforced by agent/tool-wrapper.ts, not here. */
  timeoutMs?: number;
}

export type DefinedTool = Tool & { timeoutMs?: number };

export type { Tool };

function toolContext(options: ToolExecutionOptions<unknown> | undefined): ToolContext {
  return { abortSignal: options?.abortSignal, toolCallId: options?.toolCallId };
}

async function runHandler<TInput>(
  handler: (input: TInput, context: ToolContext) => Promise<unknown>,
  onError: ((context: ToolErrorContext<TInput>) => unknown) | undefined,
  input: TInput,
  execOptions: ToolExecutionOptions<unknown> | undefined
): Promise<unknown> {
  try {
    return await handler(input, toolContext(execOptions));
  } catch (error) {
    if (onError) {
      return await onError({
        error: error instanceof Error ? error : new Error(String(error)),
        input,
        toolCallId: execOptions?.toolCallId,
      });
    }
    throw error;
  }
}

export function defineTool<TInput extends z.ZodType>(options: ToolOptions<TInput>): DefinedTool {
  const {
    description,
    schema,
    handler,
    onError,
    timeoutMs,
    toModelOutput,
    onInputStart,
    onInputDelta,
    onInputAvailable,
  } = options;

  const built: DefinedTool = aiTool({
    description,
    inputSchema: schema,
    execute: (input: z.infer<TInput>, execOptions) =>
      runHandler(handler, onError, input, execOptions),
    toModelOutput: toModelOutput
      ? ({ toolCallId, input, output }) => toModelOutput(output, { toolCallId, input })
      : undefined,
    onInputStart: onInputStart
      ? (execOptions) => onInputStart(toolContext(execOptions))
      : undefined,
    onInputDelta: onInputDelta
      ? ({ inputTextDelta, ...execOptions }) =>
          onInputDelta(inputTextDelta, toolContext(execOptions))
      : undefined,
    onInputAvailable: onInputAvailable
      ? ({ input, ...execOptions }) => onInputAvailable(input, toolContext(execOptions))
      : undefined,
  });

  built.timeoutMs = timeoutMs;
  return built;
}

/** A tool whose input is not known until run time, so the handler receives it unvalidated. */
export function defineDynamicTool(options: DynamicToolOptions): DefinedTool {
  const { description, handler, onError, timeoutMs } = options;

  const built: DefinedTool = dynamicTool({
    description,
    inputSchema: jsonSchema({ type: "object" }),
    execute: (input, execOptions) => runHandler(handler, onError, input, execOptions),
  });

  built.timeoutMs = timeoutMs;
  return built;
}
