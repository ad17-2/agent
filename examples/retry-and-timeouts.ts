import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createAgent, defineTool, z, type Logger } from "@ad17-2/agent";
import { scripted, text, toolCall } from "./mock-model.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message) => console.log("  warn:", message),
  error: (message) => console.log("  error:", message),
};

let attempts = 0;
const flaky = new MockLanguageModelV4({
  doGenerate: async () => {
    if (attempts++ === 0) {
      throw new APICallError({
        message: "Overloaded",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 529,
        isRetryable: true,
      });
    }
    return text("Answered on the second attempt.");
  },
});

const retrying = createAgent({
  model: flaky,
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  retry: { maxAttempts: 3, initialDelayMs: 50 },
  logger,
});

console.log("retry:");
const retried = await retrying.run("Hello");
console.log(`  ${retried.message} (${attempts} model calls)`);

function slowCall(ms: number, abortSignal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("done"), ms);
    abortSignal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortSignal.reason);
    });
  });
}

const slowSearch = defineTool({
  description: "Search a slow index",
  schema: z.object({ query: z.string() }),
  handler: (_input, { abortSignal }) => slowCall(10_000, abortSignal),
  timeoutMs: 50,
});

const toolTimeout = createAgent({
  model: scripted([toolCall("slowSearch", { query: "q3 report" }), text("Search timed out.")]),
  systemPrompt: "You are a research assistant.",
  tools: { slowSearch },
  onError: (error, context) => console.log(`  onError(${context.phase}):`, error.message),
});

console.log("per-tool timeout:");
const afterToolTimeout = await toolTimeout.run("Find the Q3 report");
console.log(
  "  toolsCalled:",
  JSON.stringify(afterToolTimeout.toolsCalled.map(({ name, error }) => ({ name, error })))
);
console.log("  stopReason:", afterToolTimeout.stopReason);

const exportData = defineTool({
  description: "Export a large dataset",
  schema: z.object({}),
  handler: (_input, { abortSignal }) => slowCall(10_000, abortSignal),
});

const runTimeout = createAgent({
  model: scripted([toolCall("exportData", {})]),
  systemPrompt: "You are a data assistant.",
  tools: { exportData },
  timeout: { totalMs: 60_000 },
  onError: (error, context) => console.log(`  onError(${context.phase}):`, error.message),
});

console.log("run timeout:");
const timedOut = await runTimeout.run("Export everything", { timeoutMs: 100 });
console.log("  stopReason:", timedOut.stopReason, "message:", JSON.stringify(timedOut.message));
