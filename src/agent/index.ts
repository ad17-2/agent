import {
  ToolLoopAgent,
  gateway,
  stepCountIs,
  wrapLanguageModel,
  type LanguageModel,
  type StepResult,
  type ToolSet,
} from "ai";
import { AgentError } from "../errors.js";
import { buildUserMessage } from "../message.js";
import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  Cost,
  Message,
  RetryConfig,
  RunOptions,
  SerializedHistory,
  SerializedHistoryV1,
  TokenUsage,
  ToolCallRecord,
} from "../types.js";
import { createRunSignal, retryMiddleware, type RetryOptions } from "../utils/index.js";
import { sumCost } from "../cost.js";
import { estimateTokens, modelIdOf, summarizeHistory, trimForStep } from "../context.js";
import { toAgentEvent, toTokenUsage } from "./events.js";
import { HistoryManager } from "./history.js";
import { toStopReason } from "./stop-reason.js";
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
      .filter(
        (part): part is Extract<typeof part, { type: "tool-error" }> => part.type === "tool-error"
      )
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

/** String model ids resolve like the SDK does: through the global default provider, else the gateway. */
function resolveModel(model: LanguageModel) {
  return typeof model === "string"
    ? (globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(model)
    : model;
}

function signalResult(
  stopReason: "aborted" | "timeout",
  toolsCalled: ToolCallRecord[],
  iterations: number
): AgentResult {
  return { message: "", toolsCalled, iterations, stopReason, usage: zeroUsage() };
}

export function createAgent(options: AgentOptions): Agent {
  const {
    model: modelOption,
    systemPrompt,
    tools,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    conversation,
    thinking,
    providerOptions: extraProviderOptions,
    retry: retryConfig,
    timeout: timeoutConfig,
    pricing,
    context: contextConfig,
    telemetry: telemetryConfig,
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
  const model = wrapLanguageModel({
    model: resolveModel(modelOption),
    middleware: retryMiddleware(retryOptions),
  });

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

  // functionId groups telemetry data by function in the exporter's UI; default it to traceId when unset.
  const telemetry = telemetryConfig
    ? { ...telemetryConfig, functionId: telemetryConfig.functionId ?? agentTraceId }
    : undefined;

  const sdkAgent = new ToolLoopAgent({
    model,
    instructions: systemPrompt,
    tools: wrappedTools,
    stopWhen: stepCountIs(maxIterations),
    maxOutputTokens: maxTokens,
    maxRetries: 0,
    providerOptions,
    prepareStep: contextConfig ? trimForStep(contextConfig) : undefined,
    telemetry,
  });

  /** Summarizes history when it is over budget, folding the summary's own usage/cost into `extraUsage`/`extraCost`. */
  async function summarizeIfOverBudget(): Promise<{ extraUsage: TokenUsage; extraCost?: Cost }> {
    if (!contextConfig || estimateTokens(historyManager.get()) <= contextConfig.maxInputTokens) {
      return { extraUsage: zeroUsage() };
    }

    const summarizeModel = contextConfig.summarize?.model ?? model;
    const { messages, usage } = await summarizeHistory(historyManager.get(), contextConfig, model);
    historyManager.save(messages);

    log("info", "History summarized", {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return {
      extraUsage: toTokenUsage(usage),
      extraCost: pricing
        ? sumCost([{ model: { modelId: modelIdOf(summarizeModel) }, usage }], pricing)
        : undefined,
    };
  }

  function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      totalTokens: a.totalTokens + b.totalTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    };
  }

  function addCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
    if (!a) return b;
    if (!b) return a;
    return {
      inputUsd: a.inputUsd + b.inputUsd,
      outputUsd: a.outputUsd + b.outputUsd,
      cacheReadUsd: a.cacheReadUsd + b.cacheReadUsd,
      cacheWriteUsd: a.cacheWriteUsd + b.cacheWriteUsd,
      totalUsd: a.totalUsd + b.totalUsd,
      unpricedModels: [...new Set([...a.unpricedModels, ...b.unpricedModels])],
    };
  }

  function startRun(runOptions: RunOptions | undefined) {
    return createRunSignal(
      runOptions?.timeoutMs ?? timeoutConfig?.runTimeoutMs,
      runOptions?.signal
    );
  }

  /** Logs a signal-ended run; a timeout is an error the caller hears about, an abort is not. */
  async function reportSignal(state: "aborted" | "timeout", reason: unknown, kind: string) {
    log(state === "timeout" ? "error" : "warn", `Agent ${kind} ${state}`);
    if (state === "timeout") {
      await onError?.(reason instanceof Error ? reason : new Error(String(reason)), {
        phase: "timeout",
      });
    }
  }

  return {
    async run(input: string, runOptions?: RunOptions): Promise<AgentResult> {
      const { attachments, traceId } = runOptions ?? {};
      const effectiveTraceId = traceId ?? agentTraceId;

      log("info", "Agent run started", { input: input.slice(0, 100), traceId: effectiveTraceId });

      const run = startRun(runOptions);
      const toolsCalled: ToolCallRecord[] = [];
      let stepIndex = 0;

      try {
        const initialState = run.state();
        if (initialState) return signalResult(initialState, toolsCalled, stepIndex);

        await onStart?.(input);

        const { extraUsage, extraCost } = await summarizeIfOverBudget();

        const userMessage = buildUserMessage(input, attachments);
        const messages: Message[] = [...historyManager.get(), userMessage];

        const result = await sdkAgent.generate({
          messages,
          abortSignal: run.signal,
          onStepEnd: async (step) => {
            const stepTools = buildToolCallRecords(step, toolTimings);
            toolsCalled.push(...stepTools);
            await onStep?.({ stepIndex, toolsCalled: stepTools, textGenerated: step.text });
            stepIndex++;
          },
        });

        const usage = addUsage(toTokenUsage(result.usage), extraUsage);
        const stopReason = toStopReason(
          result.finishReason,
          result.steps,
          maxIterations,
          undefined
        );

        historyManager.append(userMessage, result.responseMessages);

        const agentResult: AgentResult = {
          message: result.text,
          toolsCalled,
          iterations: result.steps.length,
          stopReason,
          usage,
          cost: pricing ? addCost(sumCost(result.steps, pricing), extraCost) : undefined,
          thinking: result.finalStep.reasoningText,
        };

        log("info", "Agent run completed", { iterations: agentResult.iterations, stopReason });
        await onComplete?.(agentResult);

        return agentResult;
      } catch (error) {
        const state = run.state();
        if (state) {
          await reportSignal(state, run.signal.reason, "run");
          return signalResult(state, toolsCalled, stepIndex);
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
      } finally {
        run.dispose();
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

      const run = startRun(runOptions);
      const toolsCalled: ToolCallRecord[] = [];
      let stepIndex = 0;
      let stepToolsCalled: ToolCallRecord[] = [];

      yield { type: "start", timestamp: Date.now() };

      try {
        const initialState = run.state();
        if (initialState) {
          const agentResult = signalResult(initialState, toolsCalled, stepIndex);
          yield { type: "complete", result: agentResult };
          return agentResult;
        }

        await onStart?.(input);

        const { extraUsage, extraCost } = await summarizeIfOverBudget();

        const userMessage = buildUserMessage(input, attachments);
        const messages: Message[] = [...historyManager.get(), userMessage];

        const streamResult = await sdkAgent.stream({
          messages,
          abortSignal: run.signal,
          onStepEnd: async (step) => {
            stepToolsCalled = buildToolCallRecords(step, toolTimings);
            toolsCalled.push(...stepToolsCalled);
            await onStep?.({ stepIndex, toolsCalled: stepToolsCalled, textGenerated: step.text });
          },
        });

        for await (const part of streamResult.fullStream) {
          // An SDK error part or abort part after a signal fired is that signal, not an API error.
          const state = run.state();
          if (part.type === "abort" || (part.type === "error" && state)) {
            await reportSignal(state ?? "aborted", run.signal.reason, "stream");
            const agentResult = signalResult(state ?? "aborted", toolsCalled, stepIndex);
            yield { type: "complete", result: agentResult };
            return agentResult;
          }

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
        }

        const text = await streamResult.text;
        const finalUsage = addUsage(toTokenUsage(await streamResult.usage), extraUsage);
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
          cost: pricing ? addCost(sumCost(steps, pricing), extraCost) : undefined,
          thinking: reasoningText,
        };

        log("info", "Agent stream completed", { iterations: agentResult.iterations, stopReason });
        await onComplete?.(agentResult);

        yield { type: "complete", result: agentResult };

        return agentResult;
      } catch (error) {
        const state = run.state();
        if (state) {
          await reportSignal(state, run.signal.reason, "stream");
          const agentResult = signalResult(state, toolsCalled, stepIndex);
          yield { type: "complete", result: agentResult };
          return agentResult;
        }

        const errorObj = error instanceof Error ? error : new Error(String(error));

        yield { type: "error", error: errorObj };

        const agentResult: AgentResult = {
          message: "",
          toolsCalled,
          iterations: stepIndex,
          stopReason: "error",
          usage: zeroUsage(),
        };

        log("error", "Agent stream failed", { error: errorObj.message });
        await onError?.(errorObj, { phase: "api" });

        yield { type: "complete", result: agentResult };

        return agentResult;
      } finally {
        // Reached on break/return from the consumer too: stop the model call so tokens stop streaming.
        run.cancel();
        run.dispose();
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
