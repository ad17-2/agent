import { AgentError } from "../errors.js";
import type { Message, SerializedHistory } from "../types.js";

export interface HistoryConfig {
  maxMessages: number;
  ttlMs: number;
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

  clear(): void {
    this.messages = [];
    this.lastUpdated = Date.now();
    this.onLog?.("History cleared");
  }

  export(): SerializedHistory {
    return {
      version: 1,
      messages: [...this.messages],
      exportedAt: Date.now(),
    };
  }

  import(serialized: SerializedHistory): void {
    if (serialized.version !== 1) {
      throw new AgentError(
        `Unsupported history version: ${serialized.version}`,
        "TOOL_VALIDATION"
      );
    }
    this.messages = [...serialized.messages];
    this.lastUpdated = Date.now();
    this.onLog?.(`History imported: ${this.messages.length} messages`);
  }
}
