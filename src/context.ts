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
import { zeroUsage } from "./usage.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_KEEP_RECENT_TURNS = 4;
const DEFAULT_SUMMARIZE_INSTRUCTIONS =
  "Summarize the conversation so far concisely, preserving facts, decisions and open questions relevant to continuing it.";

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

// Prunes only the history before this run's user message: Anthropic needs the run's own thinking
// blocks returned unchanged. Calibration state lives in the closure, so build one per run.
export function trimForStep(cfg: ContextConfig): PrepareStepFunction<ToolSet> {
  let samples: Array<{ chars: number; tokens: number }> = [];
  let lastPromptChars = 0;

  const estimate = (chars: number): number => {
    const [older, newer] = samples;
    if (!older) return chars / DEFAULT_CHARS_PER_TOKEN;
    if (newer && newer.tokens !== older.tokens) {
      const ratio = (newer.chars - older.chars) / (newer.tokens - older.tokens);
      const overhead = older.tokens - older.chars / ratio;
      if (ratio > 0 && overhead >= 0) return overhead + chars / ratio;
    }
    const last = newer ?? older;
    return (chars * last.tokens) / last.chars;
  };

  return ({ messages, steps, stepNumber, responseMessages }) => {
    if (stepNumber === 0) samples = [];
    const lastStep = steps[steps.length - 1];
    if (lastStep?.usage.inputTokens && lastPromptChars > 0) {
      samples = [
        ...samples.slice(-1),
        { chars: lastPromptChars, tokens: lastStep.usage.inputTokens },
      ];
    }

    if (Math.ceil(estimate(charsOf(messages))) <= cfg.maxInputTokens) {
      lastPromptChars = charsOf(messages);
      return {};
    }

    const historyCount = messages.length - 1 - responseMessages.length;
    const trimmed = [
      ...pruneMessages({
        messages: messages.slice(0, historyCount),
        reasoning: cfg.prune?.reasoning ?? "all",
        toolCalls: cfg.prune?.toolCalls ?? "all",
      }),
      ...messages.slice(historyCount),
    ];
    lastPromptChars = charsOf(trimmed);
    return { messages: trimmed };
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

export interface SummarizeResult {
  messages: Message[];
  usage: LanguageModelUsage;
}

/**
 * Run between turns, before a run whose history exceeds the budget. Summarizes every turn except
 * the most recent `keepRecentTurns` into one leading user message via a single `generateText` call
 * on `model` (no SDK retries: wrap the model if you want any), cutting only at turn boundaries.
 * Returns the summary's usage so the caller can fold it into the run's own usage/cost.
 */
export async function summarizeHistory(
  history: Message[],
  cfg: ContextConfig,
  model: LanguageModel,
  options: { abortSignal?: AbortSignal } = {}
): Promise<SummarizeResult> {
  const keepRecentTurns = cfg.summarize?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const instructions = cfg.summarize?.instructions ?? DEFAULT_SUMMARIZE_INSTRUCTIONS;

  const turns = splitTurns(history);
  if (turns.length <= keepRecentTurns) {
    return { messages: history, usage: zeroUsage() };
  }

  const cutIndex = turns.length - keepRecentTurns;
  const oldMessages = turns.slice(0, cutIndex).flat();
  const recentMessages = turns.slice(cutIndex).flat();

  const result = await generateText({
    model,
    instructions,
    prompt: JSON.stringify(oldMessages.map(forSummaryPrompt)),
    abortSignal: options.abortSignal,
    maxRetries: 0,
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
