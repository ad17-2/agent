import { generateText, streamText, stepCountIs, type ModelMessage, type Tool } from "ai";
import { AgentError } from "./errors.js";
import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  Attachment,
  BackoffStrategy,
  ImageInput,
  Logger,
  Message,
  RetryConfig,
  RunOptions,
  SerializedHistory,
  StepInfo,
  StopReason,
  TokenUsage,
  ToolCallRecord,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_MESSAGES = 20;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = TEN_MINUTES_MS;

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxAttempts: 3,
  backoff: "exponential",
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  retryOn: () => true,
};

export interface Agent {
  run(input: string, options?: RunOptions): Promise<AgentResult>;
  stream(input: string, options?: RunOptions): AsyncGenerator<AgentEvent, AgentResult, undefined>;
  clearHistory(): void;
  exportHistory(): SerializedHistory;
  importHistory(history: SerializedHistory): void;
}

function calculateBackoff(
  attempt: number,
  strategy: BackoffStrategy,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  let delay: number;
  switch (strategy) {
    case "fixed":
      delay = initialDelayMs;
      break;
    case "linear":
      delay = initialDelayMs * attempt;
      break;
    case "exponential":
      delay = initialDelayMs * Math.pow(2, attempt - 1);
      break;
  }
  return Math.min(delay, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs: number, existingSignal?: AbortSignal): AbortSignal {
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

export function createAgent(options: AgentOptions): Agent {
  const {
    model,
    systemPrompt,
    tools,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    conversation,
    thinking,
    retry: retryConfig,
    timeout: timeoutConfig,
    logger,
    traceId: agentTraceId,
    onStart,
    onStep,
    onToolCall,
    onToolResult,
    onError,
    onComplete,
  } = options;

  const maxMessages = conversation?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const ttlMs = conversation?.ttlMs ?? DEFAULT_TTL_MS;
  const retry = { ...DEFAULT_RETRY, ...retryConfig };

  let history: Message[] = [];
  let lastUpdated = Date.now();

  const toolTimings = new Map<string, number>();
  const wrappedTools = wrapToolsWithCallbacks(
    tools,
    toolTimings,
    logger,
    onToolCall,
    onToolResult,
    onError
  );

  function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>
  ) {
    logger?.[level](message, meta);
  }

  function getHistory(): Message[] {
    if (Date.now() - lastUpdated > ttlMs) {
      log("debug", "History expired, clearing");
      history = [];
    }
    return history;
  }

  function saveHistory(messages: Message[]): void {
    history = messages.slice(-maxMessages);
    lastUpdated = Date.now();
  }

  async function executeWithRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw new AgentError("Request was aborted", "ABORTED");
      }

      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === retry.maxAttempts) {
          break;
        }

        if (!retry.retryOn(lastError)) {
          throw lastError;
        }

        const delayMs = calculateBackoff(
          attempt,
          retry.backoff,
          retry.initialDelayMs,
          retry.maxDelayMs
        );
        log("warn", `Attempt ${attempt} failed, retrying in ${delayMs}ms`, {
          error: lastError.message,
        });

        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  function extractReasoningText(reasoning: unknown): string | undefined {
    if (!reasoning) return undefined;
    if (typeof reasoning === "string") return reasoning;
    if (Array.isArray(reasoning)) {
      return reasoning
        .map((r) => (typeof r === "object" && r !== null && "text" in r ? r.text : String(r)))
        .join("\n");
    }
    return undefined;
  }

  return {
    async run(input: string, runOptions?: RunOptions): Promise<AgentResult> {
      const { image, attachments, signal: userSignal, timeoutMs, traceId } = runOptions ?? {};
      const effectiveTraceId = traceId ?? agentTraceId;

      log("info", "Agent run started", { input: input.slice(0, 100), traceId: effectiveTraceId });

      const effectiveTimeout = timeoutMs ?? timeoutConfig?.runTimeoutMs;
      const signal = effectiveTimeout
        ? createTimeoutSignal(effectiveTimeout, userSignal)
        : userSignal;

      if (signal?.aborted) {
        throw new AgentError("Request was aborted", "ABORTED");
      }

      await onStart?.(input);

      const currentHistory = getHistory();
      const toolsCalled: ToolCallRecord[] = [];
      let stopReason: StopReason = "end_turn";
      let stepIndex = 0;

      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };

      try {
        const messages = buildMessages(currentHistory, input, image, attachments);

        const result = await executeWithRetry(
          () =>
            generateText({
              model,
              system: systemPrompt,
              messages,
              tools: wrappedTools,
              stopWhen: stepCountIs(maxIterations),
              maxOutputTokens: maxTokens,
              abortSignal: signal,
              providerOptions: thinking?.enabled
                ? {
                    anthropic: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: thinking.budgetTokens ?? 10000,
                      },
                    },
                  }
                : undefined,
              onStepFinish: async ({ toolCalls, toolResults, text }) => {
                const stepToolsCalled: ToolCallRecord[] = [];

                for (let i = 0; i < toolCalls.length; i++) {
                  const call = toolCalls[i];
                  const toolResult = toolResults[i];
                  if (call && toolResult) {
                    const record: ToolCallRecord = {
                      name: call.toolName,
                      input: call.input,
                      output: toolResult.output,
                      durationMs: toolTimings.get(call.toolCallId) ?? 0,
                    };
                    toolsCalled.push(record);
                    stepToolsCalled.push(record);
                  }
                }

                const stepInfo: StepInfo = {
                  stepIndex,
                  toolsCalled: stepToolsCalled,
                  textGenerated: text,
                };
                await onStep?.(stepInfo);
                stepIndex++;
              },
            }),
          signal
        );

        usage.inputTokens = result.usage?.inputTokens ?? 0;
        usage.outputTokens = result.usage?.outputTokens ?? 0;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;

        if (result.finishReason === "length") {
          stopReason = "max_iterations";
        } else if (result.finishReason === "stop") {
          stopReason = "end_turn";
        }

        const updatedHistory = buildHistoryFromResult(
          currentHistory,
          input,
          image,
          attachments,
          result.text
        );
        saveHistory(updatedHistory);

        const agentResult: AgentResult = {
          message: result.text,
          toolsCalled,
          iterations: result.steps.length,
          stopReason,
          usage,
          thinking: extractReasoningText(result.reasoning),
        };

        log("info", "Agent run completed", { iterations: agentResult.iterations, stopReason });
        await onComplete?.(agentResult);

        return agentResult;
      } catch (error) {
        const isTimeout = error instanceof Error && error.message.includes("timed out");
        const isAborted =
          signal?.aborted || (error instanceof AgentError && error.code === "ABORTED");

        if (isTimeout) {
          log("error", "Agent run timed out", { error: (error as Error).message });
          await onError?.(error as Error, { phase: "timeout" });
          throw new AgentError("Request timed out", "ABORTED");
        }

        if (isAborted) {
          log("warn", "Agent run aborted");
          throw new AgentError("Request was aborted", "ABORTED");
        }

        if (error instanceof AgentError) {
          throw error;
        }

        const agentError = new AgentError(
          error instanceof Error ? error.message : "Unknown error",
          "API_ERROR",
          error instanceof Error ? error : undefined
        );

        log("error", "Agent run failed", { error: agentError.message });
        await onError?.(agentError, { phase: "api" });

        throw agentError;
      }
    },

    async *stream(
      input: string,
      runOptions?: RunOptions
    ): AsyncGenerator<AgentEvent, AgentResult, undefined> {
      const { image, attachments, signal: userSignal, timeoutMs, traceId } = runOptions ?? {};
      const effectiveTraceId = traceId ?? agentTraceId;

      log("info", "Agent stream started", {
        input: input.slice(0, 100),
        traceId: effectiveTraceId,
      });

      const effectiveTimeout = timeoutMs ?? timeoutConfig?.runTimeoutMs;
      const signal = effectiveTimeout
        ? createTimeoutSignal(effectiveTimeout, userSignal)
        : userSignal;

      if (signal?.aborted) {
        throw new AgentError("Request was aborted", "ABORTED");
      }

      yield { type: "start", timestamp: Date.now() };
      await onStart?.(input);

      const currentHistory = getHistory();
      const toolsCalled: ToolCallRecord[] = [];
      let stopReason: StopReason = "end_turn";
      let stepIndex = 0;

      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };

      try {
        const messages = buildMessages(currentHistory, input, image, attachments);

        const streamResult = streamText({
          model,
          system: systemPrompt,
          messages,
          tools: wrappedTools,
          stopWhen: stepCountIs(maxIterations),
          maxOutputTokens: maxTokens,
          abortSignal: signal,
          providerOptions: thinking?.enabled
            ? {
                anthropic: {
                  thinking: {
                    type: "enabled",
                    budgetTokens: thinking.budgetTokens ?? 10000,
                  },
                },
              }
            : undefined,
          onStepFinish: async ({ toolCalls, toolResults, text }) => {
            const stepToolsCalled: ToolCallRecord[] = [];

            for (let i = 0; i < toolCalls.length; i++) {
              const call = toolCalls[i];
              const toolResult = toolResults[i];
              if (call && toolResult) {
                const record: ToolCallRecord = {
                  name: call.toolName,
                  input: call.input,
                  output: toolResult.output,
                  durationMs: toolTimings.get(call.toolCallId) ?? 0,
                };
                toolsCalled.push(record);
                stepToolsCalled.push(record);
              }
            }

            const stepInfo: StepInfo = {
              stepIndex,
              toolsCalled: stepToolsCalled,
              textGenerated: text,
            };
            await onStep?.(stepInfo);
            stepIndex++;
          },
        });

        for await (const part of streamResult.fullStream) {
          if (signal?.aborted) {
            throw new AgentError("Request was aborted", "ABORTED");
          }

          switch (part.type) {
            case "text-delta":
              yield { type: "text-delta", content: part.text };
              break;

            case "tool-call":
              yield {
                type: "tool-call-start",
                name: part.toolName,
                input: part.input,
                toolCallId: part.toolCallId,
              };
              break;

            case "tool-result":
              yield {
                type: "tool-call-complete",
                name: part.toolName,
                output: part.output,
                toolCallId: part.toolCallId,
                durationMs: toolTimings.get(part.toolCallId) ?? 0,
              };
              break;

            case "reasoning-delta":
              yield { type: "thinking", content: part.text };
              break;
          }
        }

        const text = await streamResult.text;
        const finalUsage = await streamResult.usage;
        const finishReason = await streamResult.finishReason;
        const steps = await streamResult.steps;
        const reasoning = await streamResult.reasoning;

        usage.inputTokens = finalUsage?.inputTokens ?? 0;
        usage.outputTokens = finalUsage?.outputTokens ?? 0;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;

        if (finishReason === "length") {
          stopReason = "max_iterations";
        } else if (finishReason === "stop") {
          stopReason = "end_turn";
        }

        yield { type: "text-complete", content: text };

        const updatedHistory = buildHistoryFromResult(
          currentHistory,
          input,
          image,
          attachments,
          text
        );
        saveHistory(updatedHistory);

        const agentResult: AgentResult = {
          message: text,
          toolsCalled,
          iterations: steps.length,
          stopReason,
          usage,
          thinking: extractReasoningText(reasoning),
        };

        log("info", "Agent stream completed", { iterations: agentResult.iterations, stopReason });
        await onComplete?.(agentResult);

        yield { type: "complete", result: agentResult };

        return agentResult;
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        yield { type: "error", error: errorObj };

        log("error", "Agent stream failed", { error: errorObj.message });
        await onError?.(errorObj, { phase: "api" });

        throw new AgentError(errorObj.message, "API_ERROR", errorObj);
      }
    },

    clearHistory(): void {
      history = [];
      lastUpdated = Date.now();
      log("debug", "History cleared");
    },

    exportHistory(): SerializedHistory {
      return {
        version: 1,
        messages: [...history],
        exportedAt: Date.now(),
      };
    },

    importHistory(serialized: SerializedHistory): void {
      if (serialized.version !== 1) {
        throw new AgentError(
          `Unsupported history version: ${serialized.version}`,
          "TOOL_VALIDATION"
        );
      }
      history = [...serialized.messages];
      lastUpdated = Date.now();
      log("debug", "History imported", { messageCount: history.length });
    },
  };
}

function wrapToolsWithCallbacks(
  tools: Record<string, Tool>,
  timings: Map<string, number>,
  logger: Logger | undefined,
  onToolCall?: (name: string, input: unknown) => void | Promise<void>,
  onToolResult?: (name: string, result: unknown) => void | Promise<void>,
  onError?: (
    error: Error,
    context: { phase: "tool" | "api" | "timeout"; toolName?: string }
  ) => void | Promise<void>
): Record<string, Tool> {
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

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | URL; mediaType?: string }
  | { type: "file"; data: string | URL; mediaType: string; filename?: string };

function buildMessages(
  history: Message[],
  input: string,
  image?: ImageInput,
  attachments?: Attachment[]
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const msg of history) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const hasAttachments = attachments && attachments.length > 0;
  const hasImage = !!image;

  if (hasAttachments || hasImage) {
    const content: UserContentPart[] = [];

    if (hasImage) {
      content.push({
        type: "image",
        image: image.base64,
        mediaType: image.mimeType,
      });
    }

    if (hasAttachments) {
      for (const attachment of attachments) {
        switch (attachment.type) {
          case "image":
            if (attachment.source === "base64") {
              content.push({
                type: "image",
                image: attachment.base64,
                mediaType: attachment.mimeType,
              });
            } else {
              content.push({
                type: "image",
                image: new URL(attachment.url),
              });
            }
            break;

          case "pdf":
            if (attachment.source === "base64") {
              content.push({
                type: "file",
                data: attachment.base64,
                mediaType: "application/pdf",
              });
            } else {
              content.push({
                type: "file",
                data: new URL(attachment.url),
                mediaType: "application/pdf",
              });
            }
            break;

          case "file":
            content.push({
              type: "file",
              data: attachment.base64,
              mediaType: attachment.mimeType,
              filename: attachment.filename,
            });
            break;
        }
      }
    }

    content.push({ type: "text", text: input });
    messages.push({ role: "user", content } as ModelMessage);
  } else {
    messages.push({ role: "user", content: input });
  }

  return messages;
}

function buildHistoryFromResult(
  previousHistory: Message[],
  userInput: string,
  image: ImageInput | undefined,
  attachments: Attachment[] | undefined,
  assistantResponse: string
): Message[] {
  const hasMultiModal = !!image || (attachments && attachments.length > 0);

  const userMessage: Message = hasMultiModal
    ? {
        role: "user",
        content: [{ type: "text", text: userInput }],
        timestamp: Date.now(),
      }
    : { role: "user", content: userInput, timestamp: Date.now() };

  return [
    ...previousHistory,
    userMessage,
    { role: "assistant", content: assistantResponse, timestamp: Date.now() },
  ];
}
