import { ToolLoopAgent, stepCountIs, type StepResult, type TextStreamPart, type ToolSet } from "ai";
import { AgentError } from "../errors.js";
import { buildUserMessage } from "../message.js";
import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  Message,
  RetryConfig,
  RunOptions,
  SerializedHistory,
  SerializedHistoryV1,
  TokenUsage,
  ToolCallRecord,
} from "../types.js";
import { createTimeoutSignal, executeWithRetry, type RetryOptions } from "../utils/index.js";
import { calculateBackoff, sleep } from "../utils/async.js";
import { toAgentEvent, toTokenUsage } from "./events.js";
import { HistoryManager } from "./history.js";
import { toStopReason, type SignalState } from "./stop-reason.js";
import { wrapToolsWithCallbacks } from "./tool-wrapper.js";

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
  importHistory(history: SerializedHistory | SerializedHistoryV1): void;
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

function buildToolCallRecords(
  step: StepResult<ToolSet>,
  toolTimings: ReadonlyMap<string, number>
): ToolCallRecord[] {
  const errorsById = new Map(
    step.content
      .filter((part): part is Extract<typeof part, { type: "tool-error" }> => part.type === "tool-error")
      .map((part) => [part.toolCallId, part])
  );
  const resultsById = new Map(step.toolResults.map((result) => [result.toolCallId, result]));

  return step.toolCalls.map((call) => {
    const errorPart = errorsById.get(call.toolCallId);
    const result = resultsById.get(call.toolCallId);

    return {
      name: call.toolName,
      input: call.input,
      output: result?.output,
      durationMs: toolTimings.get(call.toolCallId) ?? 0,
      error: errorPart ? true : undefined,
      errorMessage: errorPart
        ? errorPart.error instanceof Error
          ? errorPart.error.message
          : String(errorPart.error)
        : undefined,
    };
  });
}

/** Drives a stream, retrying the underlying call only if it fails before the first part is yielded. */
async function* driveStream<T extends { fullStream: AsyncIterable<TextStreamPart<ToolSet>> }>(
  mkStream: () => Promise<T>,
  retryOptions: RetryOptions
): AsyncGenerator<TextStreamPart<ToolSet>, T, undefined> {
  let firstYielded = false;

  for (let attempt = 1; ; attempt++) {
    const streamResult = await mkStream();
    try {
      for await (const part of streamResult.fullStream) {
        firstYielded = true;
        yield part;
      }
      return streamResult;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (firstYielded || attempt >= retryOptions.maxAttempts || !retryOptions.retryOn(err)) {
        throw err;
      }
      retryOptions.logger?.(`Stream attempt ${attempt} failed before first event, retrying`, {
        error: err.message,
      });
      await sleep(calculateBackoff(attempt, retryOptions.backoff, retryOptions.initialDelayMs, retryOptions.maxDelayMs));
    }
  }
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
    providerOptions: extraProviderOptions,
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

  const retry = { ...DEFAULT_RETRY, ...retryConfig };

  function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>
  ) {
    logger?.[level](message, meta);
  }

  const historyManager = new HistoryManager(
    {
      maxMessages: conversation?.maxMessages ?? DEFAULT_MAX_MESSAGES,
      ttlMs: conversation?.ttlMs ?? DEFAULT_TTL_MS,
    },
    (msg) => log("debug", msg)
  );

  const toolTimings = new Map<string, number>();
  const wrappedTools = wrapToolsWithCallbacks(
    tools,
    toolTimings,
    logger,
    { onToolCall, onToolResult, onError },
    timeoutConfig
  );

  const retryOptions: RetryOptions = {
    ...retry,
    logger: (msg, meta) => log("warn", msg, meta),
  };

  const thinkingProviderOptions = thinking?.enabled
    ? {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: thinking.budgetTokens ?? 10000 },
        },
      }
    : undefined;

  const providerOptions =
    thinkingProviderOptions || extraProviderOptions
      ? { ...thinkingProviderOptions, ...extraProviderOptions }
      : undefined;

  const sdkAgent = new ToolLoopAgent({
    model,
    instructions: systemPrompt,
    tools: wrappedTools,
    stopWhen: stepCountIs(maxIterations),
    maxOutputTokens: maxTokens,
    maxRetries: 0,
    providerOptions,
  });

  function resolveSignal(runOptions: RunOptions | undefined) {
    const { signal: userSignal, timeoutMs } = runOptions ?? {};
    const effectiveTimeout = timeoutMs ?? timeoutConfig?.runTimeoutMs;
    const signal = effectiveTimeout ? createTimeoutSignal(effectiveTimeout, userSignal) : userSignal;
    return signal;
  }

  function classifySignalFailure(signal: AbortSignal | undefined, error: unknown): SignalState {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    if (errorObj.message.includes("timed out")) return "timeout";
    if (signal?.aborted) return "aborted";
    return undefined;
  }

  return {
    async run(input: string, runOptions?: RunOptions): Promise<AgentResult> {
      const { attachments, traceId } = runOptions ?? {};
      const effectiveTraceId = traceId ?? agentTraceId;

      log("info", "Agent run started", { input: input.slice(0, 100), traceId: effectiveTraceId });

      const signal = resolveSignal(runOptions);

      if (signal?.aborted) {
        return {
          message: "",
          toolsCalled: [],
          iterations: 0,
          stopReason: "aborted",
          usage: zeroUsage(),
        };
      }

      await onStart?.(input);

      const userMessage = buildUserMessage(input, attachments);
      const messages: Message[] = [...historyManager.get(), userMessage];
      const toolsCalled: ToolCallRecord[] = [];
      let stepIndex = 0;

      try {
        const result = await executeWithRetry(
          () =>
            sdkAgent.generate({
              messages,
              abortSignal: signal,
              onStepEnd: async (step) => {
                const stepTools = buildToolCallRecords(step, toolTimings);
                toolsCalled.push(...stepTools);
                await onStep?.({ stepIndex, toolsCalled: stepTools, textGenerated: step.text });
                stepIndex++;
              },
            }),
          retryOptions,
          signal
        );

        const usage = toTokenUsage(result.usage);
        const stopReason = toStopReason(result.finishReason, result.steps, maxIterations, undefined);

        historyManager.append(userMessage, result.responseMessages);

        const agentResult: AgentResult = {
          message: result.text,
          toolsCalled,
          iterations: result.steps.length,
          stopReason,
          usage,
          thinking: result.finalStep.reasoningText,
        };

        log("info", "Agent run completed", { iterations: agentResult.iterations, stopReason });
        await onComplete?.(agentResult);

        return agentResult;
      } catch (error) {
        const signalState = classifySignalFailure(signal, error);

        if (signalState) {
          log(signalState === "timeout" ? "error" : "warn", `Agent run ${signalState}`);
          if (signalState === "timeout") {
            await onError?.(error instanceof Error ? error : new Error(String(error)), {
              phase: "timeout",
            });
          }
          return {
            message: "",
            toolsCalled,
            iterations: stepIndex,
            stopReason: signalState,
            usage: zeroUsage(),
          };
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
      const { attachments, traceId } = runOptions ?? {};
      const effectiveTraceId = traceId ?? agentTraceId;

      log("info", "Agent stream started", {
        input: input.slice(0, 100),
        traceId: effectiveTraceId,
      });

      const signal = resolveSignal(runOptions);

      yield { type: "start", timestamp: Date.now() };

      if (signal?.aborted) {
        const agentResult: AgentResult = {
          message: "",
          toolsCalled: [],
          iterations: 0,
          stopReason: "aborted",
          usage: zeroUsage(),
        };
        yield { type: "complete", result: agentResult };
        return agentResult;
      }

      await onStart?.(input);

      const userMessage = buildUserMessage(input, attachments);
      const messages: Message[] = [...historyManager.get(), userMessage];
      const toolsCalled: ToolCallRecord[] = [];
      let stepIndex = 0;
      let stepToolsCalled: ToolCallRecord[] = [];

      const gen = driveStream(
        () =>
          sdkAgent.stream({
            messages,
            abortSignal: signal,
            onStepEnd: async (step) => {
              stepToolsCalled = buildToolCallRecords(step, toolTimings);
              toolsCalled.push(...stepToolsCalled);
              await onStep?.({ stepIndex, toolsCalled: stepToolsCalled, textGenerated: step.text });
            },
          }),
        retryOptions
      );

      try {
        let next = await gen.next();
        while (!next.done) {
          const part = next.value;
          const evt = toAgentEvent(part, toolTimings, stepIndex, stepToolsCalled);
          if (evt) yield evt;

          if (part.type === "finish-step") {
            stepIndex++;
            stepToolsCalled = [];
          }

          if (evt?.type === "error") {
            const agentResult: AgentResult = {
              message: "",
              toolsCalled,
              iterations: stepIndex,
              stopReason: "error",
              usage: zeroUsage(),
            };
            log("error", "Agent stream failed mid-stream", { error: evt.error.message });
            await onError?.(evt.error, { phase: "api" });
            yield { type: "complete", result: agentResult };
            return agentResult;
          }

          next = await gen.next();
        }

        const streamResult = next.value;
        const text = await streamResult.text;
        const finalUsage = toTokenUsage(await streamResult.usage);
        const finishReason = await streamResult.finishReason;
        const steps = await streamResult.steps;
        const responseMessages = await streamResult.responseMessages;
        const reasoningText = (await streamResult.finalStep).reasoningText;

        const stopReason = toStopReason(finishReason, steps, maxIterations, undefined);

        yield { type: "text-complete", content: text };

        historyManager.append(userMessage, responseMessages);

        const agentResult: AgentResult = {
          message: text,
          toolsCalled,
          iterations: steps.length,
          stopReason,
          usage: finalUsage,
          thinking: reasoningText,
        };

        log("info", "Agent stream completed", { iterations: agentResult.iterations, stopReason });
        await onComplete?.(agentResult);

        yield { type: "complete", result: agentResult };

        return agentResult;
      } catch (error) {
        const signalState = classifySignalFailure(signal, error);
        const errorObj = error instanceof Error ? error : new Error(String(error));

        yield { type: "error", error: errorObj };

        const agentResult: AgentResult = {
          message: "",
          toolsCalled,
          iterations: stepIndex,
          stopReason: signalState ?? "error",
          usage: zeroUsage(),
        };

        log("error", "Agent stream failed", { error: errorObj.message });
        await onError?.(errorObj, { phase: "api" });

        yield { type: "complete", result: agentResult };

        return agentResult;
      }
    },

    clearHistory(): void {
      historyManager.clear();
    },

    exportHistory(): SerializedHistory {
      return historyManager.export();
    },

    importHistory(serialized: SerializedHistory | SerializedHistoryV1): void {
      historyManager.import(serialized);
    },
  };
}
