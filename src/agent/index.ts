import {
  ToolLoopAgent,
  isStepCount,
  wrapLanguageModel,
  type LanguageModel,
  type StepResult,
  type ToolSet,
} from "ai";
import { AgentError } from "../errors.js";
import { buildUserMessage } from "../message.js";
import type {
  Agent,
  AgentEvent,
  AgentOptions,
  AgentResult,
  Cost,
  LogLevel,
  Message,
  RetryConfig,
  RunOptions,
  SerializedHistory,
  SerializedHistoryV1,
  TokenUsage,
  ToolCallRecord,
} from "../types.js";
import {
  createRunSignal,
  isRetryableError,
  retryMiddleware,
  type RetryOptions,
} from "../utils/index.js";
import { addCost, sumCost } from "../cost.js";
import { estimateTokens, summarizeHistory, trimForStep } from "../context.js";
import { addUsage, toTokenUsage, zeroUsage } from "../usage.js";
import { toAgentEvent } from "./events.js";
import { HistoryManager } from "./history.js";
import { buildProviderOptions, modelIdOf, resolveModel } from "./model.js";
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
  retryOn: isRetryableError,
};

function buildToolCallRecords(step: StepResult<ToolSet>): ToolCallRecord[] {
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
      durationMs: step.performance.toolExecutionMs[call.toolCallId] ?? 0,
      error: errorPart ? true : undefined,
      errorMessage: errorPart
        ? errorPart.error instanceof Error
          ? errorPart.error.message
          : String(errorPart.error)
        : undefined,
    };
  });
}

function signalResult(
  stopReason: "aborted" | "timeout",
  toolsCalled: ToolCallRecord[],
  iterations: number
): AgentResult {
  return { message: "", toolsCalled, iterations, stopReason, usage: toTokenUsage(zeroUsage()) };
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

  // Field by field so an explicit `undefined` still takes the default.
  const retry: Required<RetryConfig> = {
    maxAttempts: retryConfig?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    backoff: retryConfig?.backoff ?? DEFAULT_RETRY.backoff,
    initialDelayMs: retryConfig?.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
    maxDelayMs: retryConfig?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    retryOn: retryConfig?.retryOn ?? DEFAULT_RETRY.retryOn,
  };

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    logger?.[level](message, meta);
  }

  const historyManager = new HistoryManager(
    {
      maxMessages: conversation?.maxMessages ?? DEFAULT_MAX_MESSAGES,
      ttlMs: conversation?.ttlMs ?? DEFAULT_TTL_MS,
    },
    (msg) => log("debug", msg)
  );

  const wrappedTools = wrapToolsWithCallbacks(
    tools,
    logger,
    { onToolCall, onToolResult, onError },
    timeoutConfig
  );

  const retryOptions: RetryOptions = {
    ...retry,
    logger: (msg, meta) => log("warn", msg, meta),
  };
  /** Built per call: a string id resolves like the SDK does, at call time, so a provider registered later is honoured. */
  function callModel(model: LanguageModel) {
    return wrapLanguageModel({
      model: resolveModel(model),
      middleware: retryMiddleware(retryOptions),
    });
  }

  const providerOptions = buildProviderOptions(thinking, extraProviderOptions);

  const telemetry = telemetryConfig
    ? { ...telemetryConfig, functionId: telemetryConfig.functionId ?? agentTraceId }
    : undefined;

  const sdkAgent = new ToolLoopAgent({
    model: modelOption,
    instructions: systemPrompt,
    tools: wrappedTools,
    stopWhen: isStepCount(maxIterations),
    maxOutputTokens: maxTokens,
    maxRetries: 0,
    providerOptions,
    telemetry,
    // Per call: the model is resolved and wrapped now, and trimForStep's calibration is this run's own.
    prepareCall: (call) => ({
      ...call,
      model: callModel(modelOption),
      prepareStep: contextConfig ? trimForStep(contextConfig) : undefined,
    }),
  });

  async function summarizeIfOverBudget(
    abortSignal: AbortSignal
  ): Promise<{ extraUsage: TokenUsage; extraCost?: Cost }> {
    if (!contextConfig || estimateTokens(historyManager.get()) <= contextConfig.maxInputTokens) {
      return { extraUsage: toTokenUsage(zeroUsage()) };
    }

    const summarizeModel = callModel(contextConfig.summarize?.model ?? modelOption);
    const { messages, usage } = await summarizeHistory(
      historyManager.get(),
      contextConfig,
      summarizeModel,
      { abortSignal }
    );
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

        const { extraUsage, extraCost } = await summarizeIfOverBudget(run.signal);

        const userMessage = buildUserMessage(input, attachments);
        const messages: Message[] = [...historyManager.get(), userMessage];

        const result = await sdkAgent.generate({
          messages,
          abortSignal: run.signal,
          onStepEnd: async (step) => {
            const stepTools = buildToolCallRecords(step);
            toolsCalled.push(...stepTools);
            await onStep?.({ stepIndex, toolsCalled: stepTools, textGenerated: step.text });
            stepIndex++;
          },
        });

        const usage = addUsage(toTokenUsage(result.usage), extraUsage);
        const stopReason = toStopReason(result.finishReason, result.steps.length, maxIterations);

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
      const recordsByStep: ToolCallRecord[][] = [];
      let wake: (() => void) | undefined;
      // Filled by onToolExecutionEnd, which the SDK awaits before it enqueues the tool-result part.
      const toolTimings = new Map<string, number>();

      // Every yield sits inside this try, so a consumer that stops after any event reaches the finally.
      try {
        yield { type: "start", timestamp: Date.now() };

        const initialState = run.state();
        if (initialState) {
          const agentResult = signalResult(initialState, toolsCalled, stepIndex);
          yield { type: "complete", result: agentResult };
          return agentResult;
        }

        await onStart?.(input);

        const { extraUsage, extraCost } = await summarizeIfOverBudget(run.signal);

        const userMessage = buildUserMessage(input, attachments);
        const messages: Message[] = [...historyManager.get(), userMessage];

        const streamResult = await sdkAgent.stream({
          messages,
          abortSignal: run.signal,
          onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
            toolTimings.set(toolCall.toolCallId, toolExecutionMs);
          },
          onStepEnd: async (step) => {
            const stepTools = buildToolCallRecords(step);
            toolsCalled.push(...stepTools);
            await onStep?.({
              stepIndex: step.stepNumber,
              toolsCalled: stepTools,
              textGenerated: step.text,
            });
            recordsByStep[step.stepNumber] = stepTools;
            wake?.();
          },
        });
        const streamEnded = streamResult.steps.then(
          () => true,
          () => true
        );
        /**
         * The SDK enqueues `finish-step` before it runs `onStepEnd`, so this step's records may not
         * exist yet when the part arrives. Waits for them; gives up once the stream has settled.
         */
        const stepRecords = async (index: number): Promise<ToolCallRecord[]> => {
          let records = recordsByStep[index];
          while (!records) {
            const ended = await Promise.race([
              new Promise<boolean>((resolve) => {
                wake = () => resolve(false);
              }),
              streamEnded,
            ]);
            records = recordsByStep[index];
            if (ended) return records ?? [];
          }
          return records;
        };

        for await (const part of streamResult.fullStream) {
          // An SDK error part or abort part after a signal fired is that signal, not an API error.
          const state = run.state();
          if (part.type === "abort" || (part.type === "error" && state)) {
            await reportSignal(state ?? "aborted", run.signal.reason, "stream");
            const agentResult = signalResult(state ?? "aborted", toolsCalled, stepIndex);
            yield { type: "complete", result: agentResult };
            return agentResult;
          }

          const stepTools = part.type === "finish-step" ? await stepRecords(stepIndex) : [];
          const evt = toAgentEvent(part, toolTimings, stepIndex, stepTools);
          if (evt) yield evt;

          if (part.type === "finish-step") stepIndex++;

          if (evt?.type === "error") {
            const agentResult: AgentResult = {
              message: "",
              toolsCalled,
              iterations: stepIndex,
              stopReason: "error",
              usage: toTokenUsage(zeroUsage()),
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

        const stopReason = toStopReason(finishReason, steps.length, maxIterations);

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
          usage: toTokenUsage(zeroUsage()),
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
