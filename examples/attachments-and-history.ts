import { createAgent, type SerializedHistory } from "@ad17-2/agent";
import { scripted, text } from "./mock-model.ts";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const first = createAgent({
  model: scripted([text("A single white pixel.")]),
  systemPrompt: "You describe images.",
  tools: {},
});

const turn1 = await first.run("What is in this image?", {
  attachments: [{ type: "image", source: "base64", base64: pixel, mimeType: "image/png" }],
});
console.log("turn 1:", turn1.message);

const saved = JSON.stringify(first.exportHistory());
console.log("exported", saved.length, "bytes");

const model = scripted([text("It was white.")]);
const second = createAgent({ model, systemPrompt: "You describe images.", tools: {} });
const restored: SerializedHistory = JSON.parse(saved);
second.importHistory(restored);

const turn2 = await second.run("What colour was it?");
console.log("turn 2:", turn2.message);

const prompt = model.doGenerateCalls[0]!.prompt;
for (const message of prompt) {
  const parts = Array.isArray(message.content)
    ? message.content.map((part) =>
        "mediaType" in part ? `${part.type}(${part.mediaType})` : part.type
      )
    : ["text"];
  console.log(`turn 2 prompt: ${message.role} [${parts.join(", ")}]`);
}
