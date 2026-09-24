import { createAgent } from "@ad17-2/agent";
import { scripted, text } from "./mock-model.ts";

const agent = createAgent({
  model: scripted([
    text("The release notes cover three fixes and one breaking change. ".repeat(10), 1_200, 400),
    text("You're welcome.", 900, 5),
    text("Version 2 ships on Friday.", 300, 20),
  ]),
  systemPrompt: "You are a release assistant.",
  tools: {},
  pricing: {
    "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
    "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  },
  context: {
    maxInputTokens: 100,
    summarize: {
      keepRecentTurns: 1,
      model: scripted(
        [text("The user asked about the release notes.", 250, 15)],
        "claude-haiku-4-5"
      ),
    },
  },
});

const first = await agent.run("Explain the release notes.");
console.log("turn 1 cost:", first.cost);

await agent.run("Thanks.");
console.log("history after turn 2:", agent.exportHistory().messages.length, "messages");

const third = await agent.run("When does version 2 ship?");
console.log("turn 3 usage, including the summary call:", third.usage);
console.log("turn 3 cost, including the summary call:", third.cost);

const history = agent.exportHistory().messages;
console.log("history after turn 3:", history.length, "messages, starting with:");
console.log(" ", history[0]?.content);
