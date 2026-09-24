import { AgentError } from "../errors.js";
import type { Message, SerializedHistory, SerializedHistoryV1 } from "../types.js";

export interface HistoryConfig {
  maxMessages: number;
  ttlMs: number;
}

/**
 * Splits history into turns, each starting at a user message, so a tool call is never separated
 * from its result. Messages before the first user message belong to no turn and are dropped.
 */
export function splitTurns(history: ReadonlyArray<Message>): Message[][] {
  const turns: Message[][] = [];
  for (const msg of history) {
    if (msg.role === "user") turns.push([msg]);
    else turns[turns.length - 1]?.push(msg);
  }
  return turns;
}

/** Keeps the newest whole turns that fit in `maxMessages`; the newest turn is always kept, even when it alone exceeds the cap. */
function evictTurns(history: ReadonlyArray<Message>, maxMessages: number): Message[] {
  const turns = splitTurns(history);
  let kept = 0;
  let start = turns.length;
  while (start > 0) {
    const size = turns[start - 1]!.length;
    if (kept > 0 && kept + size > maxMessages) break;
    kept += size;
    start--;
  }
  return turns.slice(start).flat();
}

function textOf(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text)
    .join("\n");
}

/** Converts a pre-ai-7 serialized history into v2: text blocks are kept, tool-call/tool-result blocks dropped. */
function fromV1(serialized: SerializedHistoryV1): Message[] {
  return serialized.messages.flatMap((msg): Message[] => {
    const content = textOf(msg.content);
    if (content === "") return [];
    return [
      msg.role === "user"
        ? { role: "user", content, timestamp: msg.timestamp }
        : { role: "assistant", content, timestamp: msg.timestamp },
    ];
  });
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
    this.messages = evictTurns(messages, this.maxMessages);
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
      this.save(fromV1(serialized));
      this.onLog?.(`History imported (v1 -> v2): ${this.messages.length} messages`);
      return;
    }

    if (serialized.version !== 2) {
      throw new AgentError(
        `Unsupported history version: ${(serialized as { version: number }).version}`,
        "TOOL_VALIDATION"
      );
    }

    this.save(serialized.messages);
    this.onLog?.(`History imported: ${this.messages.length} messages`);
  }
}
