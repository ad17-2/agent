import { AgentError } from "../errors.js";
import type {
  ApprovalDecision,
  Message,
  PendingApproval,
  SerializedHistory,
  SerializedHistoryV1,
  ToolCallRecord,
} from "../types.js";

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

/**
 * Requests with no matching response yet, joined to their tool call for the name and input.
 * The stored request part carries only `toolCallId`; automatic approve/deny requests are never pending.
 */
export function pendingApprovals(history: ReadonlyArray<Message>): PendingApproval[] {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  const pending = new Map<string, PendingApproval>();
  for (const msg of history) {
    if (typeof msg.content === "string") continue;
    for (const part of msg.content) {
      if (part.type === "tool-call") {
        calls.set(part.toolCallId, { toolName: part.toolName, input: part.input });
      } else if (part.type === "tool-approval-request" && !part.isAutomatic) {
        const call = calls.get(part.toolCallId);
        if (!call) continue;
        pending.set(part.approvalId, {
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
          ...call,
          ...(part.reason !== undefined ? { reason: part.reason } : {}),
        });
      } else if (part.type === "tool-approval-response") {
        pending.delete(part.approvalId);
      }
    }
  }
  return [...pending.values()];
}

/** The tool message that answers every pending request; throws INVALID_APPROVAL unless each id is decided exactly once. */
export function approvalResponseMessage(
  pending: ReadonlyArray<PendingApproval>,
  decisions: ReadonlyArray<ApprovalDecision>
): Message {
  if (pending.length === 0) {
    throw new AgentError("No approval is pending", "INVALID_APPROVAL");
  }
  const pendingIds = new Set(pending.map((p) => p.approvalId));
  const seen = new Set<string>();
  const unknown: string[] = [];
  const duplicate: string[] = [];
  for (const { approvalId } of decisions) {
    if (!pendingIds.has(approvalId)) unknown.push(approvalId);
    else if (seen.has(approvalId)) duplicate.push(approvalId);
    seen.add(approvalId);
  }
  const missing = [...pendingIds].filter((id) => !seen.has(id));
  const problems = [
    ...(unknown.length > 0 ? [`unknown: ${unknown.join(", ")}`] : []),
    ...(duplicate.length > 0 ? [`duplicate: ${duplicate.join(", ")}`] : []),
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
  ];
  if (problems.length > 0) {
    throw new AgentError(`Invalid approval ids (${problems.join("; ")})`, "INVALID_APPROVAL");
  }
  return {
    role: "tool",
    content: decisions.map((d) => ({
      type: "tool-approval-response",
      approvalId: d.approvalId,
      approved: d.approved,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
    })),
  };
}

/**
 * Records for the tools the SDK ran (or denied) before step 0 of a resume. Their results are in
 * the first response message and in no step, and the output is the model-facing value.
 */
export function preLoopToolRecords(
  pending: ReadonlyArray<PendingApproval>,
  responseMessages: ReadonlyArray<Message>,
  timings: ReadonlyMap<string, number>
): ToolCallRecord[] {
  const first = responseMessages[0];
  if (first?.role !== "tool") return [];
  const records: ToolCallRecord[] = [];
  for (const { toolCallId, toolName, input } of pending) {
    const result = first.content.find(
      (part) => part.type === "tool-result" && part.toolCallId === toolCallId
    );
    if (result?.type !== "tool-result") continue;
    const { output } = result;
    const record: ToolCallRecord = {
      name: toolName,
      input,
      output: output.type === "text" || output.type === "json" ? output.value : undefined,
      durationMs: timings.get(toolCallId) ?? 0,
    };
    if (output.type === "execution-denied") {
      record.error = output.reason === undefined ? "denied" : `denied: ${output.reason}`;
    } else if (output.type === "error-text" || output.type === "error-json") {
      record.error = typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    }
    records.push(record);
  }
  return records;
}

function textOf(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
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

  /** Appends the turn's input message (user, or tool on a resume) and the SDK's own response messages. */
  append(inputMessage: Message, responseMessages: Message[]): void {
    const timestamp = Date.now();
    this.save([
      ...this.messages,
      { ...inputMessage, timestamp },
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
    const version: number = serialized.version;
    if (serialized.version === 1) {
      this.save(fromV1(serialized));
      this.onLog?.(`History imported (v1 -> v2): ${this.messages.length} messages`);
      return;
    }

    if (serialized.version !== 2) {
      throw new AgentError(`Unsupported history version: ${version}`, "INVALID_HISTORY");
    }

    this.save(serialized.messages);
    this.onLog?.(`History imported: ${this.messages.length} messages`);
  }
}
