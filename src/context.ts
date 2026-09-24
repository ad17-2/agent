import {
  generateText,
  pruneMessages,
  type FilePart,
  type ImagePart,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type TextPart,
  type ToolSet,
} from "ai";
import { splitTurns } from "./agent/history.js";
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
export function estimateTokens(
  messages: ReadonlyArray<ModelMessage>,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN
): number {
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

function placeholder(part: FilePart | ImagePart): TextPart {
  const filename = part.type === "file" ? part.filename : undefined;
  return {
    type: "text",
    text: `[attachment: ${part.mediaType ?? "unknown"}${filename ? ` ${filename}` : ""}]`,
  };
}

/** Strips timestamps and replaces file/image parts with a placeholder so base64 payloads never reach the summariser. */
function forSummaryPrompt({ timestamp: _timestamp, ...msg }: Message): ModelMessage {
  if (msg.role === "user" && typeof msg.content !== "string") {
    return {
      ...msg,
      content: msg.content.map((part) =>
        part.type === "file" || part.type === "image" ? placeholder(part) : part
      ),
    };
  }
  if (msg.role === "assistant" && typeof msg.content !== "string") {
    return {
      ...msg,
      content: msg.content.map((part) => (part.type === "file" ? placeholder(part) : part)),
    };
  }
  return msg;
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
 * the most recent `keepRecentTurns` into one leading user message via `generateText`, cutting only
 * at turn boundaries. Returns the summary's usage so the caller can fold it into the run's own usage/cost.
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
    prompt: JSON.stringify(oldMessages.map(forSummaryPrompt)),
  });

  const summaryMessage: Message = {
    role: "user",
    content: `Summary of earlier conversation: ${result.text}`,
    timestamp: Date.now(),
  };

  return {
    messages: [summaryMessage, ...recentMessages],
    usage: result.usage,
  };
}
