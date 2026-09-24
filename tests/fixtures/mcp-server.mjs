// Minimal real MCP server for tests/mcp.test.ts, run as a child process over stdio.
// Tool names come from argv (default: echo). The low-level Server is used because
// McpServer.registerTool rejects names that exist on Object.prototype.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const toolNames = process.argv.length > 2 ? process.argv.slice(2) : ["echo"];

const server = new Server(
  { name: "fixture-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolNames.map((name) => ({
    name,
    description: "Echoes the given text back, uppercased",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const text = params.arguments?.text;
  return {
    content: [{ type: "text", text: typeof text === "string" ? text.toUpperCase() : "" }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
