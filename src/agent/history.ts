import { AgentError } from "../errors.js";
import type { Message, SerializedHistory, SerializedHistoryV1 } from "../types.js";

export interface HistoryConfig {
  maxMessages: number;
  ttlMs: number;
}

/** Converts a pre-ai-7 (text-only) serialized history into v2 ModelMessage-based history. */
function fromV1(serialized: SerializedHistoryV1): Message[] {
  return serialized.messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    timestamp: msg.timestamp,
  })) as Message[];
}

export class HistoryManager {
  private messages: Message[] = [];
  private lastUpdated = Date.now();
  private readonly maxMessages: number;
  private readonly ttlMs: number;
  private readonly onLog?: (message: string) => void;

  constructor(config: HistoryConfig, onLog?: (message: string) => void) {
    this.maxMessages = config.maxMessages;
    this.ttlMs = config.ttlMs;
    this.onLog = onLog;
  }

  get(): Message[] {
    if (Date.now() - this.lastUpdated > this.ttlMs) {
      this.onLog?.("History expired, clearing");
      this.messages = [];
    }
    return this.messages;
  }

  save(messages: Message[]): void {
    this.messages = messages.slice(-this.maxMessages);
    this.lastUpdated = Date.now();
  }

  /** Appends a user turn and the SDK's own response messages, preserving tool calls/results and file parts. */
  append(userMessage: Message, responseMessages: Message[]): void {
    const timestamp = Date.now();
    this.save([
      ...this.messages,
      { ...userMessage, timestamp },
      ...responseMessages.map((msg) => ({ ...msg, timestamp })),
    ]);
  }

  clear(): void {
    this.messages = [];
    this.lastUpdated = Date.now();
    this.onLog?.("History cleared");
  }

  export(): SerializedHistory {
    return {
      version: 2,
      messages: [...this.messages],
      exportedAt: Date.now(),
    };
  }

  import(serialized: SerializedHistory | SerializedHistoryV1): void {
    if (serialized.version === 1) {
      this.messages = fromV1(serialized);
      this.lastUpdated = Date.now();
      this.onLog?.(`History imported (v1 -> v2): ${this.messages.length} messages`);
      return;
    }

    if (serialized.version !== 2) {
      throw new AgentError(
        `Unsupported history version: ${(serialized as { version: number }).version}`,
        "TOOL_VALIDATION"
      );
    }

    this.messages = [...serialized.messages];
    this.lastUpdated = Date.now();
    this.onLog?.(`History imported: ${this.messages.length} messages`);
  }
}
