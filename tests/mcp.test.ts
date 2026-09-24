import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { MCPTransport } from "@ai-sdk/mcp";
import { loadMcpTools } from "../src/mcp.js";
import { createAgent } from "../src/agent/index.js";
import { AgentError } from "../src/errors.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

function echoServer(name: string, prefix?: string) {
  return {
    name,
    transport: new Experimental_StdioMCPTransport({ command: process.execPath, args: [fixturePath] }),
    prefix,
  };
}

function usage(inputTokens = 10, outputTokens = 20) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

describe("loadMcpTools", () => {
  it("loads tools from a real MCP server over stdio, and an agent gets the real tool result", async () => {
    const mcp = await loadMcpTools([echoServer("fixture")]);

    try {
      expect(Object.keys(mcp.tools)).toEqual(["echo"]);

      let callIndex = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "echo",
                  input: JSON.stringify({ text: "hello" }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: usage(),
              warnings: [],
            };
          }
          return {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: usage(),
            warnings: [],
          };
        },
      });

      const agent = createAgent({ model, systemPrompt: "Test", tools: mcp.tools });
      const result = await agent.run("echo hello");

      expect(result.message).toBe("done");
      const echoCall = result.toolsCalled.find((c) => c.name === "echo");
      expect(echoCall).toBeDefined();
      expect(JSON.stringify(echoCall!.output)).toContain("HELLO");
    } finally {
      await mcp.close();
    }
  });

  it("throws MCP_TOOL_CONFLICT when two servers expose the same tool name", async () => {
    await expect(loadMcpTools([echoServer("server-a"), echoServer("server-b")])).rejects.toThrow(AgentError);

    try {
      await loadMcpTools([echoServer("server-a"), echoServer("server-b")]);
      expect.unreachable();
    } catch (error) {
      expect(AgentError.is(error)).toBe(true);
      expect((error as AgentError).code).toBe("MCP_TOOL_CONFLICT");
    }
  });

  it("applies an opt-in prefix, avoiding a clash between two servers with the same tool name", async () => {
    const mcp = await loadMcpTools([echoServer("server-a", "a_"), echoServer("server-b", "b_")]);
    try {
      expect(Object.keys(mcp.tools).sort()).toEqual(["a_echo", "b_echo"]);
    } finally {
      await mcp.close();
    }
  });

  it("closes already-opened clients before rethrowing when a later server fails to connect", async () => {
    class SpyTransport implements MCPTransport {
      closed = false;
      constructor(private readonly real: MCPTransport) {}
      get supportsProtocolVersionDiscovery() {
        return this.real.supportsProtocolVersionDiscovery;
      }
      start() {
        return this.real.start();
      }
      send(message: Parameters<MCPTransport["send"]>[0], options?: Parameters<MCPTransport["send"]>[1]) {
        return this.real.send(message, options);
      }
      async close(options?: Parameters<MCPTransport["close"]>[0]) {
        this.closed = true;
        await this.real.close(options);
      }
      set onclose(fn: (() => void) | undefined) {
        this.real.onclose = fn;
      }
      get onclose() {
        return this.real.onclose;
      }
      set onerror(fn: ((error: Error) => void) | undefined) {
        this.real.onerror = fn;
      }
      get onerror() {
        return this.real.onerror;
      }
      set onmessage(fn: ((message: Parameters<MCPTransport["send"]>[0]) => void) | undefined) {
        this.real.onmessage = fn;
      }
      get onmessage() {
        return this.real.onmessage;
      }
    }

    const spy = new SpyTransport(
      new Experimental_StdioMCPTransport({ command: process.execPath, args: [fixturePath] })
    );

    await expect(
      loadMcpTools([
        { name: "good", transport: spy },
        // nothing listens on this port: the connection attempt fails
        { name: "bad", transport: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      ])
    ).rejects.toThrow();

    expect(spy.closed).toBe(true);
  });
});
