import { generateText, stepCountIs, type ModelMessage, type Tool } from "ai";
import { AgentError } from "./errors.js";
import type {
  AgentOptions,
  AgentResult,
  Message,
  RunOptions,
  StopReason,
  ToolCallRecord,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_MESSAGES = 20;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = TEN_MINUTES_MS;

export interface Agent {
  run(input: string, options?: RunOptions): Promise<AgentResult>;
  clearHistory(): void;
}

export function createAgent(options: AgentOptions): Agent {
  const {
    model,
    systemPrompt,
    tools,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    conversation,
    onToolCall,
    onToolResult,
  } = options;

  const maxMessages = conversation?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const ttlMs = conversation?.ttlMs ?? DEFAULT_TTL_MS;

  let history: Message[] = [];
  let lastUpdated = Date.now();

  const toolTimings = new Map<string, number>();
  const wrappedTools = wrapToolsWithCallbacks(tools, toolTimings, onToolCall, onToolResult);

  function getHistory(): Message[] {
    if (Date.now() - lastUpdated > ttlMs) {
      history = [];
    }
    return history;
  }

  function saveHistory(messages: Message[]): void {
    history = messages.slice(-maxMessages);
    lastUpdated = Date.now();
  }

  return {
    async run(input: string, runOptions?: RunOptions): Promise<AgentResult> {
      const { image, signal } = runOptions ?? {};

      if (signal?.aborted) {
        throw new AgentError("Request was aborted", "ABORTED");
      }

      const currentHistory = getHistory();
      const toolsCalled: ToolCallRecord[] = [];
      let stopReason: StopReason = "end_turn";

      try {
        const messages = buildMessages(currentHistory, input, image);

        const result = await generateText({
          model,
          system: systemPrompt,
          messages,
          tools: wrappedTools,
          stopWhen: stepCountIs(maxIterations),
          maxOutputTokens: maxTokens,
          abortSignal: signal,
          onStepFinish: ({ toolCalls, toolResults }) => {
            for (let i = 0; i < toolCalls.length; i++) {
              const call = toolCalls[i];
              const toolResult = toolResults[i];
              if (call && toolResult) {
                toolsCalled.push({
                  name: call.toolName,
                  input: call.input,
                  output: toolResult.output,
                  durationMs: toolTimings.get(call.toolCallId) ?? 0,
                });
              }
            }
          },
        });

        if (result.finishReason === "length") {
          stopReason = "max_iterations";
        } else if (result.finishReason === "stop") {
          stopReason = "end_turn";
        }

        const updatedHistory = buildHistoryFromResult(
          currentHistory,
          input,
          image,
          result.text
        );
        saveHistory(updatedHistory);

        return {
          message: result.text,
          toolsCalled,
          iterations: result.steps.length,
          stopReason,
        };
      } catch (error) {
        if (signal?.aborted) {
          throw new AgentError("Request was aborted", "ABORTED");
        }

        if (error instanceof AgentError) {
          throw error;
        }

        throw new AgentError(
          error instanceof Error ? error.message : "Unknown error",
          "API_ERROR",
          error instanceof Error ? error : undefined
        );
      }
    },

    clearHistory(): void {
      history = [];
      lastUpdated = Date.now();
    },
  };
}

function wrapToolsWithCallbacks(
  tools: Record<string, Tool>,
  timings: Map<string, number>,
  onToolCall?: (name: string, input: unknown) => void,
  onToolResult?: (name: string, result: unknown) => void
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }

    const originalExecute = tool.execute;

    wrapped[name] = {
      ...tool,
      execute: async (
        args: Parameters<typeof originalExecute>[0],
        execOptions: Parameters<typeof originalExecute>[1]
      ) => {
        const toolCallId = execOptions?.toolCallId ?? "";
        const start = Date.now();
        
        onToolCall?.(name, args);
        const result = await originalExecute(args, execOptions);
        onToolResult?.(name, result);
        
        timings.set(toolCallId, Date.now() - start);
        return result;
      },
    };
  }

  return wrapped;
}

function buildMessages(
  history: Message[],
  input: string,
  image?: { base64: string; mimeType: string }
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const msg of history) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "image", image: image.base64, mediaType: image.mimeType },
        { type: "text", text: input },
      ],
    });
  } else {
    messages.push({ role: "user", content: input });
  }

  return messages;
}

function buildHistoryFromResult(
  previousHistory: Message[],
  userInput: string,
  image: { base64: string; mimeType: string } | undefined,
  assistantResponse: string
): Message[] {
  const userMessage: Message = image
    ? {
        role: "user",
        content: [
          { type: "image", image: image.base64, mimeType: image.mimeType },
          { type: "text", text: userInput },
        ],
      }
    : { role: "user", content: userInput };

  return [
    ...previousHistory,
    userMessage,
    { role: "assistant", content: assistantResponse },
  ];
}
