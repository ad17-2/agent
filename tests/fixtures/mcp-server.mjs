// Minimal real MCP server for tests/mcp.test.ts, run as a child process over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture-mcp-server", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes the given text back, uppercased",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: text.toUpperCase() }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
