import { createMCPClient, type MCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import { AgentError } from "./errors.js";

export interface McpServer {
  name: string;
  transport: MCPClientConfig["transport"];
  /** Tool names from this server become `${prefix}${toolName}`. Opt-in. */
  prefix?: string;
}

export interface LoadedMcp {
  tools: ToolSet;
  close(): Promise<void>;
}

/**
 * Connects to each MCP server and merges their tools into one ToolSet. A tool name clash between
 * two servers throws AgentError("MCP_TOOL_CONFLICT"); a clash with a caller's own local tools is
 * the caller's responsibility (spread order when building the tools passed to createAgent). If any
 * server fails to connect, every client already opened is closed before the error is rethrown.
 */
export async function loadMcpTools(servers: McpServer[]): Promise<LoadedMcp> {
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};

  try {
    for (const server of servers) {
      const client = await createMCPClient({ transport: server.transport });
      clients.push(client);

      const serverTools = await client.tools();
      for (const [toolName, tool] of Object.entries(serverTools)) {
        const name = server.prefix ? `${server.prefix}${toolName}` : toolName;
        if (Object.hasOwn(tools, name)) {
          throw new AgentError(
            `MCP tool name conflict: "${name}" from server "${server.name}"`,
            "MCP_TOOL_CONFLICT"
          );
        }
        tools[name] = tool;
      }
    }
  } catch (error) {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    throw error;
  }

  return {
    tools,
    async close() {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}
