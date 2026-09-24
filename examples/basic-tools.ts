import { createAgent, defineTool, z } from "@ad17-2/agent";
import { scripted, text, toolCall } from "./mock-model.ts";

const getWeather = defineTool({
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
  handler: async ({ city }) => ({ city, temperatureC: 22, conditions: "sunny" }),
});

const agent = createAgent({
  model: scripted([toolCall("getWeather", { city: "Tokyo" }), text("Tokyo is 22°C and sunny.")]),
  systemPrompt: "You are a weather assistant.",
  tools: { getWeather },
});

const result = await agent.run("What's the weather in Tokyo?");

console.log("message:", result.message);
console.log("toolsCalled:", result.toolsCalled);
console.log("usage:", result.usage);
console.log("stopReason:", result.stopReason, "after", result.iterations, "steps");
