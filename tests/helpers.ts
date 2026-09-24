import { simulateReadableStream, type ToolExecutionOptions } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { AgentEvent } from "../src/types.js";

export function usage(inputTokens = 10, outputTokens = 20): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

export function textResult(
  text: string,
  inputTokens = 10,
  outputTokens = 20
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(inputTokens, outputTokens),
    warnings: [],
  };
}

export function toolCallResult(
  toolName: string,
  input: unknown = {},
  toolCallId = "call-1"
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: usage(),
    warnings: [],
  };
}

/** One doStream per element: a multi-step stream is one chunk list per step. */
export function streamModel(...steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({ stream: simulateReadableStream({ chunks }) })),
  });
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export function executeOptions(
  toolCallId = "test-id",
  abortSignal?: AbortSignal
): ToolExecutionOptions<undefined> {
  return { toolCallId, abortSignal, context: undefined, messages: [] };
}
