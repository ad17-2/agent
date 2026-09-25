import { createAgent, type UIMessage } from "@ad17-2/agent";
import { scriptedStream, usage } from "./mock-model.ts";

const agent = createAgent({
  model: scriptedStream([
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hello " },
      { type: "text-delta", id: "t", delta: "from the agent." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(20, 6) },
    ],
  ]),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
});

const messages: UIMessage[] = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }];

const stream = await agent.uiStream(messages);
for await (const chunk of stream) {
  console.log(chunk.type, chunk.type === "text-delta" ? JSON.stringify(chunk.delta) : "");
}
