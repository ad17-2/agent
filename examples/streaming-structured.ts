import { streamStructured, z } from "@ad17-2/agent";
import { scriptedStream, usage } from "./mock-model.ts";

const model = scriptedStream([
  [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: '{"name":"Ali' },
    { type: "text-delta", id: "t", delta: 'ce","role":"engi' },
    { type: "text-delta", id: "t", delta: 'neer","years":7}' },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(60, 18) },
  ],
]);

const result = streamStructured({
  model,
  schema: z.object({ name: z.string(), role: z.string(), years: z.number() }),
  prompt: "Extract the person: Alice has been an engineer for 7 years.",
});

for await (const partial of result.partial) console.log("partial:", partial);

console.log("output:", await result.output);
console.log("usage:", (await result.usage).totalTokens, "tokens");
