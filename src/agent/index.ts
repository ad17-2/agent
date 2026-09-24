import {
  ToolLoopAgent,
  isStepCount,
  wrapLanguageModel,
  type FinishReason,
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
  Attachment,
  Cost,
  LogLevel,
  Message,
  RetryConfig,
  RunOptions,
  SerializedHistory,
  SerializedHistoryV1,
  TokenUsage,
} from "../types.js";
import {
  createRunSignal,
  isRetryableError,
  retryMiddleware,
  type RetryOptions,
  type RunSignal,
} from "../utils/index.js";
import type { SignalState } from "../utils/timeout.js";
import { addCost, sumCost } from "../cost.js";
import { estimateTokens, summarizeHistory, trimForStep } from "../context.js";
import { addUsage, toTokenUsage, zeroUsage } from "../usage.js";
import { toAgentEvent } from "./events.js";
import { HistoryManager } from "./history.js";
import { buildProviderOptions, modelIdOf, resolveModel } from "./model.js";
import { StepRecorder } from "./recorder.js";
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

interface Turn {
  kind: "run" | "stream";
  input: string;
  attachments: Attachment[] | undefined;
  run: RunSignal;
  recorder: StepRecorder;
}

interface TurnStart {
  userMessage: Message;
  messages: Message[];
  extra: { usage: TokenUsage; cost?: Cost };
}

interface TurnEnd {
  text: string;
  usage: Parameters<typeof toTokenUsage>[0];
  finishReason: FinishReason;
  steps: ReadonlyArray<StepResult<ToolSet>>;
  responseMessages: Message[];
  reasoningText: string | undefined;
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

  const sdkAgent = new ToolLoopAgent({
    model: modelOption,
    instructions: systemPrompt,
    tools: wrapToolsWithCallbacks(
      tools,
      logger,
      { onToolCall, onToolResult, onError },
      timeoutConfig
    ),
    stopWhen: isStepCount(maxIterations),
    maxOutputTokens: maxTokens,
    maxRetries: 0,
    providerOptions: buildProviderOptions(thinking, extraProviderOptions),
    telemetry: telemetryConfig
      ? { ...telemetryConfig, functionId: telemetryConfig.functionId ?? agentTraceId }
      : undefined,
    // Per call: the model is resolved and wrapped now, and trimForStep's calibration is this run's own.
    prepareCall: (call) => ({
      ...call,
      model: callModel(modelOption),
      prepareStep: contextConfig ? trimForStep(contextConfig) : undefined,
    }),
  });

  async function summarizeIfOverBudget(abortSignal: AbortSignal): Promise<TurnStart["extra"]> {
    if (!contextConfig || estimateTokens(historyManager.get()) <= contextConfig.maxInputTokens) {
      return { usage: toTokenUsage(zeroUsage()) };
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
      usage: toTokenUsage(usage),
      cost: pricing
        ? sumCost([{ model: { modelId: modelIdOf(summarizeModel) }, usage }], pricing)
        : undefined,
    };
  }

  /** Logs the start and arms the run signal; the timer runs from here. */
  function openTurn(kind: Turn["kind"], input: string, runOptions: RunOptions | undefined): Turn {
    const { attachments, traceId, timeoutMs, signal } = runOptions ?? {};
    log("info", `Agent ${kind} started`, {
      input: input.slice(0, 100),
      traceId: traceId ?? agentTraceId,
    });
    return {
      kind,
      input,
      attachments,
      run: createRunSignal(timeoutMs ?? timeoutConfig?.runTimeoutMs, signal),
      recorder: new StepRecorder(onStep),
    };
  }

  /** Pre-abort check, onStart, summarisation and the user message; a signal state means the turn is over. */
  async function startTurn(turn: Turn): Promise<TurnStart | NonNullable<SignalState>> {
    const state = turn.run.state();
    if (state) return state;

    await onStart?.(turn.input);
    const extra = await summarizeIfOverBudget(turn.run.signal);
    const userMessage = buildUserMessage(turn.input, turn.attachments);
    return { userMessage, messages: [...historyManager.get(), userMessage], extra };
  }

  async function finishTurn(turn: Turn, start: TurnStart, end: TurnEnd): Promise<AgentResult> {
    historyManager.append(start.userMessage, end.responseMessages);

    const stopReason = toStopReason(end.finishReason, end.steps.length, maxIterations);
    const result: AgentResult = {
      message: end.text,
      toolsCalled: turn.recorder.toolsCalled,
      iterations: end.steps.length,
      stopReason,
      usage: addUsage(toTokenUsage(end.usage), start.extra.usage),
      cost: pricing ? addCost(sumCost(end.steps, pricing), start.extra.cost) : undefined,
      thinking: end.reasoningText,
    };

    log("info", `Agent ${turn.kind} completed`, { iterations: result.iterations, stopReason });
    await onComplete?.(result);
    return result;
  }

  function emptyResult(turn: Turn, stopReason: "aborted" | "timeout" | "error"): AgentResult {
    return {
      message: "",
      toolsCalled: turn.recorder.toolsCalled,
      iterations: turn.recorder.stepIndex,
      stopReason,
      usage: toTokenUsage(zeroUsage()),
    };
  }

  /** A timeout is an error the caller hears about, an abort is not. */
  async function endBySignal(turn: Turn, state: NonNullable<SignalState>): Promise<AgentResult> {
    log(state === "timeout" ? "error" : "warn", `Agent ${turn.kind} ${state}`);
    if (state === "timeout") {
      const reason = turn.run.signal.reason;
      await onError?.(reason instanceof Error ? reason : new Error(String(reason)), {
        phase: "timeout",
      });
    }
    return emptyResult(turn, state);
  }

  async function reportApiError(error: Error, message: string): Promise<void> {
    log("error", message, { error: error.message });
    await onError?.(error, { phase: "api" });
  }

  return {
    async run(input: string, runOptions?: RunOptions): Promise<AgentResult> {
      const turn = openTurn("run", input, runOptions);
      try {
        const start = await startTurn(turn);
        if (typeof start === "string") return endBySignal(turn, start);

        const result = await sdkAgent.generate({
          messages: start.messages,
          abortSignal: turn.run.signal,
          onStepEnd: (step) => turn.recorder.onStepEnd(step),
        });

        return await finishTurn(turn, start, {
          text: result.text,
          usage: result.usage,
          finishReason: result.finishReason,
          steps: result.steps,
          responseMessages: result.responseMessages,
          reasoningText: result.finalStep.reasoningText,
        });
      } catch (error) {
        const state = turn.run.state();
        if (state) return endBySignal(turn, state);
        if (error instanceof AgentError) throw error;

        const agentError = new AgentError(
          error instanceof Error ? error.message : "Unknown error",
          "API_ERROR",
          error instanceof Error ? error : undefined
        );
        await reportApiError(agentError, "Agent run failed");
        throw agentError;
      } finally {
        turn.run.dispose();
      }
    },

    async *stream(
      input: string,
      runOptions?: RunOptions
    ): AsyncGenerator<AgentEvent, AgentResult, undefined> {
      const turn = openTurn("stream", input, runOptions);
      const { run, recorder } = turn;
      // Every yield sits inside this try, so a consumer that stops after any event reaches the finally.
      try {
        yield { type: "start", timestamp: Date.now() };

        const start = await startTurn(turn);
        if (typeof start === "string") {
          const result = await endBySignal(turn, start);
          yield { type: "complete", result };
          return result;
        }

        const streamResult = await sdkAgent.stream({
          messages: start.messages,
          abortSignal: run.signal,
          onToolExecutionEnd: (event) => recorder.onToolExecutionEnd(event),
          onStepEnd: (step) => recorder.onStepEnd(step),
        });
        const settled = streamResult.steps.then(
          () => undefined,
          () => undefined
        );

        for await (const part of streamResult.fullStream) {
          // An SDK error part or abort part after a signal fired is that signal, not an API error.
          const state = run.state();
          if (part.type === "abort" || (part.type === "error" && state)) {
            const result = await endBySignal(turn, state ?? "aborted");
            yield { type: "complete", result };
            return result;
          }

          if (part.type === "finish-step") {
            const step = await recorder.takeStep(settled);
            yield { type: "step-complete", ...step, usage: toTokenUsage(part.usage) };
            continue;
          }

          const evt = toAgentEvent(part, recorder.toolTimings);
          if (evt) yield evt;

          if (evt?.type === "error") {
            await reportApiError(evt.error, "Agent stream failed mid-stream");
            const result = emptyResult(turn, "error");
            yield { type: "complete", result };
            return result;
          }
        }

        const text = await streamResult.text;
        yield { type: "text-complete", content: text };

        const result = await finishTurn(turn, start, {
          text,
          usage: await streamResult.usage,
          finishReason: await streamResult.finishReason,
          steps: await streamResult.steps,
          responseMessages: await streamResult.responseMessages,
          reasoningText: (await streamResult.finalStep).reasoningText,
        });
        yield { type: "complete", result };
        return result;
      } catch (error) {
        const state = run.state();
        if (state) {
          const result = await endBySignal(turn, state);
          yield { type: "complete", result };
          return result;
        }

        const errorObj = error instanceof Error ? error : new Error(String(error));
        yield { type: "error", error: errorObj };
        await reportApiError(errorObj, "Agent stream failed");
        const result = emptyResult(turn, "error");
        yield { type: "complete", result };
        return result;
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
