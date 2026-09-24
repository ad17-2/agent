import { fileURLToPath } from "node:url";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createAgent } from "@ad17-2/agent";
import { loadMcpTools } from "@ad17-2/agent/mcp";
import { scripted, text, toolCall } from "./mock-model.ts";

const server = fileURLToPath(new URL("../tests/fixtures/mcp-server.mjs", import.meta.url));

const mcp = await loadMcpTools([
  {
    name: "fixture",
    transport: new Experimental_StdioMCPTransport({ command: process.execPath, args: [server] }),
    prefix: "fixture_",
  },
]);

try {
  console.log("MCP tools:", Object.keys(mcp.tools));

  const agent = createAgent({
    model: scripted([
      toolCall("fixture_echo", { text: "hello from mcp" }),
      text("The server shouted back."),
    ]),
    systemPrompt: "You are a helpful assistant.",
    tools: mcp.tools,
  });

  const result = await agent.run("Echo a greeting");
  console.log("tool output:", JSON.stringify(result.toolsCalled[0]?.output));
  console.log("message:", result.message);
} finally {
  await mcp.close();
}
