import { createAgent, defineTool, hasToolCall, z } from "@ad17-2/agent";
import { scripted, toolCall } from "./mock-model.ts";

const search = defineTool({
  description: "Search the docs",
  schema: z.object({ query: z.string() }),
  handler: async ({ query }) => [`${query}: set maxIterations to cap the loop`],
});

const submitAnswer = defineTool({
  description: "Submit the final answer",
  schema: z.object({ answer: z.string() }),
  handler: async ({ answer }) => answer,
});

const model = scripted([
  toolCall("search", { query: "loop cap" }, "call-1"),
  toolCall("submitAnswer", { answer: "Use maxIterations." }, "call-2"),
]);

const agent = createAgent({
  model,
  systemPrompt: "Research, then submit an answer.",
  tools: { search, submitAnswer },
  stopWhen: hasToolCall("submitAnswer"),
  prepareStep: ({ stepNumber }) =>
    stepNumber === 0
      ? { activeTools: ["search"] }
      : { activeTools: ["submitAnswer"], toolChoice: "required" },
});

const result = await agent.run("How do I cap the agent loop?");

model.doGenerateCalls.forEach((call, i) => {
  console.log(
    `step ${i} tools:`,
    call.tools?.map((t) => t.name)
  );
});
console.log(
  "toolsCalled:",
  result.toolsCalled.map((t) => [t.name, t.output])
);
console.log("stopReason:", result.stopReason, "after", result.iterations, "steps");
