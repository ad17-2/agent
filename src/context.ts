import {
  generateText,
  pruneMessages,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type ToolSet,
} from "ai";
import type { ContextConfig, Message } from "./types.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_KEEP_RECENT_TURNS = 4;
const DEFAULT_SUMMARIZE_INSTRUCTIONS =
  "Summarize the conversation so far concisely, preserving facts, decisions and open questions relevant to continuing it.";

/** Resolves a LanguageModel (a model instance or a provider:model id string) to its modelId. */
export function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

function charsOf(messages: ReadonlyArray<ModelMessage>): number {
  return messages.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);
}

/** chars/4 token estimate; pass `charsPerToken` to calibrate against a real usage.inputTokens measurement. */
export function estimateTokens(messages: ReadonlyArray<ModelMessage>, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.ceil(charsOf(messages) / charsPerToken);
}

/**
 * prepareStep hook: once the calibrated estimate for the step's messages exceeds `maxInputTokens`,
 * prunes reasoning and tool call/result content from everything but the last message via the SDK's
 * `pruneMessages`. Calibrates its chars/token ratio from the previous step's real usage.inputTokens.
 */
export function trimForStep(cfg: ContextConfig): PrepareStepFunction<ToolSet> {
  let charsPerToken = DEFAULT_CHARS_PER_TOKEN;

  return ({ messages, steps }) => {
    const lastStep = steps[steps.length - 1];
    if (lastStep?.usage.inputTokens) {
      const chars = charsOf(messages);
      if (chars > 0) charsPerToken = chars / lastStep.usage.inputTokens;
    }

    if (estimateTokens(messages, charsPerToken) <= cfg.maxInputTokens) {
      return {};
    }

    return {
      messages: pruneMessages({
        messages,
        reasoning: "before-last-message",
        toolCalls: "before-last-message",
      }),
    };
  };
}

/** Splits history into turns, each starting at a user message, so a tool call is never separated from its result. */
function splitTurns(history: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const msg of history) {
    if (msg.role === "user" || turns.length === 0) {
      turns.push([msg]);
    } else {
      turns[turns.length - 1]!.push(msg);
    }
  }
  return turns;
}

function zeroUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  };
}

export interface SummarizeResult {
  messages: Message[];
  usage: LanguageModelUsage;
}

/**
 * Run between turns, before a run whose history exceeds the budget. Summarizes every turn except
 * the most recent `keepRecentTurns` into one assistant message via `generateText`, cutting only at
 * turn boundaries. Returns the summary's usage so the caller can fold it into the run's own usage/cost.
 */
export async function summarizeHistory(
  history: Message[],
  cfg: ContextConfig,
  model: LanguageModel
): Promise<SummarizeResult> {
  const keepRecentTurns = cfg.summarize?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const summarizeModel = cfg.summarize?.model ?? model;
  const instructions = cfg.summarize?.instructions ?? DEFAULT_SUMMARIZE_INSTRUCTIONS;

  const turns = splitTurns(history);
  if (turns.length <= keepRecentTurns) {
    return { messages: history, usage: zeroUsage() };
  }

  const cutIndex = turns.length - keepRecentTurns;
  const oldMessages = turns.slice(0, cutIndex).flat();
  const recentMessages = turns.slice(cutIndex).flat();

  const result = await generateText({
    model: summarizeModel,
    system: instructions,
    prompt: JSON.stringify(oldMessages.map(({ timestamp: _timestamp, ...rest }) => rest)),
  });

  const summaryMessage: Message = {
    role: "assistant",
    content: result.text,
    timestamp: Date.now(),
  };

  return {
    messages: [summaryMessage, ...recentMessages],
    usage: result.usage,
  };
}
