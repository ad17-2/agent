import { createAgent, defineDynamicTool, defineTool, z } from "@ad17-2/agent";
import { scriptedStream, usage } from "./mock-model.ts";

const searchOrders = defineTool({
  description: "Search orders by customer",
  schema: z.object({ customer: z.string() }),
  handler: async ({ customer }) => ({
    customer,
    orders: [
      { id: "A1", total: 120, lines: ["..."] },
      { id: "A2", total: 80, lines: ["..."] },
    ],
  }),
  // The model sees a one-line summary; result.toolsCalled keeps the full object.
  toModelOutput: (_output, { input }) => ({
    type: "text",
    value: `2 orders for ${input.customer}`,
  }),
  onInputStart: ({ toolCallId }) => console.log("input started:", toolCallId),
  onInputDelta: (delta) => console.log("input delta:", delta),
  onInputAvailable: (input) => console.log("input ready:", input),
});

// Input is not known until run time (e.g. a plugin's tool), so it arrives unvalidated.
const plugin = defineDynamicTool({
  description: "Call a plugin action",
  handler: async (input) => ({ ran: input }),
});

const model = scriptedStream([
  [
    { type: "tool-input-start", id: "call-1", toolName: "searchOrders" },
    { type: "tool-input-delta", id: "call-1", delta: '{"customer":' },
    { type: "tool-input-delta", id: "call-1", delta: '"ann"}' },
    { type: "tool-input-end", id: "call-1" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "searchOrders",
      input: '{"customer":"ann"}',
    },
    { type: "tool-call", toolCallId: "call-2", toolName: "plugin", input: '{"action":"sync"}' },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: usage(40, 20),
    },
  ],
  [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "Ann has 2 orders; the plugin synced." },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(60, 10) },
  ],
]);

const agent = createAgent({
  model,
  systemPrompt: "You are a support agent.",
  tools: { searchOrders, plugin },
});

for await (const event of agent.stream("What has Ann ordered? Then sync the plugin.")) {
  if (event.type === "tool-input-start") console.log("event tool-input-start:", event.name);
  if (event.type === "tool-input-delta") console.log("event tool-input-delta:", event.delta);
  if (event.type === "complete") {
    console.log("toolsCalled:", JSON.stringify(event.result.toolsCalled.map((t) => t.output)));
    console.log("message:", event.result.message);
  }
}

const toolMessage = model.doStreamCalls[1]?.prompt.find((m) => m.role === "tool");
console.log("model saw:", JSON.stringify(toolMessage?.content[0]));
