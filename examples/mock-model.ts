import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** Scripted stand-ins for a real provider, so every example runs with no API key. */

export function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

export function text(reply: string, input = 20, output = 10): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text: reply }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: usage(input, output),
    warnings: [],
  };
}

export function toolCall(
  toolName: string,
  input: unknown,
  toolCallId = "call-1"
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: usage(30, 15),
    warnings: [],
  };
}

/** Answers each model call with the next scripted result. */
export function scripted(
  results: LanguageModelV4GenerateResult[],
  modelId = "claude-sonnet-5"
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ modelId, doGenerate: results });
}

/** One chunk list per streamed step. */
export function scriptedStream(steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({ stream: simulateReadableStream({ chunks }) })),
  });
}
