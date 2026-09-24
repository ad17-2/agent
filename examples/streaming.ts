import { createAgent, defineTool, z, type AgentEvent } from "@ad17-2/agent";
import { scriptedStream, usage } from "./mock-model.ts";

const lookup = defineTool({
  description: "Look up an order",
  schema: z.object({ id: z.string() }),
  handler: async ({ id }) => ({ id, status: "shipped" }),
});

const refund = defineTool({
  description: "Refund an order",
  schema: z.object({ id: z.string() }),
  handler: async () => {
    throw new Error("refunds are disabled");
  },
});

function print(event: AgentEvent): void {
  switch (event.type) {
    case "start":
      console.log("start");
      break;
    case "thinking":
      console.log("thinking:", event.content);
      break;
    case "text-delta":
      console.log("text-delta:", JSON.stringify(event.content));
      break;
    case "text-complete":
      console.log("text-complete:", event.content);
      break;
    case "tool-call-start":
      console.log("tool-call-start:", event.name, event.input);
      break;
    case "tool-call-complete":
      console.log("tool-call-complete:", event.name, event.output);
      break;
    case "tool-call-error":
      console.log("tool-call-error:", event.name, event.error);
      break;
    case "step-complete":
      console.log(
        `step-complete: step ${event.stepIndex}, tools [${event.toolsCalled.map((t) => t.name).join(", ")}], ${event.usage.totalTokens} tokens`
      );
      break;
    case "error":
      console.log("error:", event.error.message);
      break;
    case "complete":
      console.log("complete: stopReason", event.result.stopReason);
      break;
  }
}

const agent = createAgent({
  model: scriptedStream([
    [
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "Check the order, then try the refund." },
      { type: "reasoning-end", id: "r" },
      { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: '{"id":"A1"}' },
      { type: "tool-call", toolCallId: "call-2", toolName: "refund", input: '{"id":"A1"}' },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(40, 20),
      },
    ],
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Order A1 has shipped. " },
      { type: "text-delta", id: "t", delta: "I could not refund it." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(80, 12) },
    ],
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Let me" },
      { type: "error", error: { message: "connection reset", isRetryable: false } },
    ],
  ]),
  systemPrompt: "You are a support agent.",
  tools: { lookup, refund },
});

for await (const event of agent.stream("Where is order A1? Refund it.")) print(event);

console.log("--- a stream that fails after output has started");
for await (const event of agent.stream("And order B2?")) print(event);
