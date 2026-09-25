import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import type { AgentEvent, AgentOptions, ApprovalDecision } from "../src/types.js";
import { collect, streamModel, textResult, toolCallResult, usage } from "./helpers.js";

function gatedTool(handler: () => Promise<string> = async () => "ran") {
  const spy = vi.fn(handler);
  const t = defineTool({ description: "Gated", schema: z.object({ x: z.number() }), handler: spy });
  return { t, spy };
}

/** call 1: the model calls `t`; call 2: it answers. */
function gatedAgent(overrides: Partial<AgentOptions> = {}) {
  const { t, spy } = gatedTool();
  const model = new MockLanguageModelV4({
    doGenerate: [toolCallResult("t", { x: 1 }), textResult("done")],
  });
  const agent = createAgent({
    model,
    systemPrompt: "Test",
    tools: { t },
    toolApproval: { t: "user-approval" },
    ...overrides,
  });
  return { agent, model, spy, t };
}

function approve(approvalId: string, approved = true, reason?: string): ApprovalDecision {
  return reason === undefined ? { approvalId, approved } : { approvalId, approved, reason };
}

const toolStep: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "call-1", toolName: "t", input: '{"x":1}' },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage() },
];

const textStep: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: "done" },
  { type: "text-end", id: "1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
];

describe("tool approval: the request turn", () => {
  it("1. stops with needs_approval and one pending approval carrying the tool call", async () => {
    const { agent, spy } = gatedAgent();

    const result = await agent.run("go");

    expect(result.stopReason).toBe("needs_approval");
    expect(result.pendingApprovals).toEqual([
      { approvalId: expect.any(String), toolCallId: "call-1", toolName: "t", input: { x: 1 } },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("2. an automatic denial is not pending and is recorded as a denied call", async () => {
    const { agent, spy } = gatedAgent({ toolApproval: { t: "denied" } });

    const result = await agent.run("go");

    expect(result.stopReason).toBe("end_turn");
    expect(result.pendingApprovals).toBeUndefined();
    expect(result.toolsCalled[0]?.error).toBe("denied");
    expect(spy).not.toHaveBeenCalled();
  });

  it("2b. an automatic denial with a reason is recorded as 'denied: <reason>'", async () => {
    const { agent } = gatedAgent({ toolApproval: { t: { type: "denied", reason: "policy" } } });

    const result = await agent.run("go");

    expect(result.toolsCalled[0]?.error).toBe("denied: policy");
  });

  it("2c. a gated call under finish reason 'stop' still stops with needs_approval", async () => {
    const { t, spy } = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: [
        { ...toolCallResult("t", { x: 1 }), finishReason: { unified: "stop", raw: "end_turn" } },
        textResult("done"),
      ],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
    });

    const result = await agent.run("go");

    expect(result.stopReason).toBe("needs_approval");
    expect(result.pendingApprovals).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("tool approval: the resume turn", () => {
  it("3. an approval executes the tool once, feeds the model its result and extends history", async () => {
    const { agent, model, spy } = gatedAgent();
    const first = await agent.run("go");
    const [pending] = first.pendingApprovals ?? [];

    const result = await agent.run({ approvals: [approve(pending!.approvalId)] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolsCalled[0]).toMatchObject({ name: "t", input: { x: 1 }, output: "ran" });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('"ran"');
    const roles = agent.exportHistory().messages.map((m) => m.role);
    expect(roles.slice(-2)).toEqual(["tool", "assistant"]);
  });

  it("4. a denial never runs the handler and the model sees execution-denied with the reason", async () => {
    const { agent, model, spy } = gatedAgent();
    const first = await agent.run("go");
    const [pending] = first.pendingApprovals ?? [];

    const result = await agent.run({ approvals: [approve(pending!.approvalId, false, "no")] });

    expect(spy).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolsCalled[0]).toMatchObject({
      name: "t",
      output: undefined,
      error: "denied: no",
    });
    const prompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(prompt).toContain("execution-denied");
    expect(prompt).toContain('"no"');
  });

  it("4b. a resumed tool with toModelOutput records the raw result while the model sees the mapped one", async () => {
    const t = defineTool({
      description: "Gated",
      schema: z.object({ x: z.number() }),
      handler: async () => ({ secret: 1, rows: 2 }),
      toModelOutput: () => ({ type: "text", value: "summary" }),
    });
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("t", { x: 1 }), textResult("done")],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
    });
    const first = await agent.run("go");

    const result = await agent.run({
      approvals: first.pendingApprovals!.map((p) => approve(p.approvalId)),
    });

    expect(result.toolsCalled).toEqual([
      {
        name: "t",
        input: { x: 1 },
        output: { secret: 1, rows: 2 },
        durationMs: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("summary");
  });

  it("5. an unknown, duplicate or missing id, or nothing pending, throws INVALID_APPROVAL naming the ids", async () => {
    const { agent, spy } = gatedAgent();
    const first = await agent.run("go");
    const id = first.pendingApprovals![0]!.approvalId;
    const before = agent.exportHistory().messages;

    await expect(agent.run({ approvals: [approve("nope")] })).rejects.toThrow(
      expect.objectContaining({
        code: "INVALID_APPROVAL",
        message: expect.stringContaining("nope"),
      })
    );
    await expect(agent.run({ approvals: [approve(id), approve(id)] })).rejects.toThrow(
      expect.objectContaining({ code: "INVALID_APPROVAL", message: expect.stringContaining(id) })
    );
    await expect(agent.run({ approvals: [] })).rejects.toThrow(
      expect.objectContaining({ code: "INVALID_APPROVAL", message: expect.stringContaining(id) })
    );
    expect(agent.exportHistory().messages).toEqual(before);
    expect(spy).not.toHaveBeenCalled();

    const fresh = gatedAgent();
    await expect(fresh.agent.run({ approvals: [] })).rejects.toThrow(
      expect.objectContaining({ code: "INVALID_APPROVAL" })
    );
    expect(fresh.model.doGenerateCalls).toHaveLength(0);
  });

  it("6. a text turn while an approval is pending throws APPROVAL_PENDING and leaves history alone", async () => {
    const { agent, model } = gatedAgent();
    await agent.run("go");
    const before = agent.exportHistory().messages;

    await expect(agent.run("more text")).rejects.toThrow(
      expect.objectContaining({ code: "APPROVAL_PENDING" })
    );

    expect(agent.exportHistory().messages).toEqual(before);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("7. pending approvals survive export and import into a fresh agent", async () => {
    const { agent, t } = gatedAgent();
    const first = await agent.run("go");

    const other = createAgent({
      model: new MockLanguageModelV4({ doGenerate: [textResult("done")] }),
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
    });
    other.importHistory(agent.exportHistory());

    expect(other.pendingApprovals()).toEqual(first.pendingApprovals);
    const result = await other.run({
      approvals: other.pendingApprovals().map((p) => approve(p.approvalId)),
    });
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("tool approval: stream", () => {
  it("8. yields approval-request before complete, and complete carries the same pending list", async () => {
    const { t } = gatedTool();
    const agent = createAgent({
      model: streamModel(toolStep),
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
    });

    const events = await collect(agent.stream("go"));

    const request = events.find(
      (e): e is Extract<AgentEvent, { type: "approval-request" }> => e.type === "approval-request"
    );
    const complete = events.find((e) => e.type === "complete");
    expect(request).toBeDefined();
    expect(events.indexOf(request!)).toBeLessThan(events.indexOf(complete!));
    expect(complete).toMatchObject({
      result: { stopReason: "needs_approval", pendingApprovals: [request?.approval] },
    });
  });

  it("9. a resumed stream yields tool-call-complete for the approved tool before the first step-complete", async () => {
    const { t } = gatedTool();
    const agent = createAgent({
      model: streamModel(toolStep, textStep),
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
    });
    await collect(agent.stream("go"));
    const [pending] = agent.pendingApprovals();

    const events = await collect(agent.stream({ approvals: [approve(pending!.approvalId)] }));

    const types = events.map((e) => e.type);
    const complete = types.indexOf("tool-call-complete");
    expect(complete).toBeGreaterThan(-1);
    expect(complete).toBeLessThan(types.indexOf("step-complete"));
    expect(events[complete]).toMatchObject({ name: "t", output: "ran", toolCallId: "call-1" });
    expect(events.at(-1)).toMatchObject({ result: { stopReason: "end_turn" } });
  });

  it("9b. an automatic approval never yields approval-request", async () => {
    const { t, spy } = gatedTool();
    const agent = createAgent({
      model: streamModel(toolStep, textStep),
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "approved" },
    });

    const events = await collect(agent.stream("go"));

    expect(events.map((e) => e.type)).not.toContain("approval-request");
    expect(events.at(-1)).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("tool approval: interactions", () => {
  it("10. an abort during the resume keeps the request pending, and the same decisions resume again", async () => {
    const { t, spy } = gatedTool(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "ran";
    });
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) => {
        call++;
        if (call === 1) return Promise.resolve(toolCallResult("t", { x: 1 }));
        if (call === 2) {
          // Like fetch: rejects at once on an aborted signal, else when it fires.
          return new Promise((_resolve, reject) => {
            if (abortSignal?.aborted) return reject(abortSignal.reason);
            abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), {
              once: true,
            });
          });
        }
        return Promise.resolve(textResult("done"));
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
    });
    const first = await agent.run("go");
    const approvals = first.pendingApprovals!.map((p) => approve(p.approvalId));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const aborted = await agent.run({ approvals }, { abortSignal: controller.signal });

    expect(aborted.stopReason).toBe("aborted");
    expect(agent.pendingApprovals()).toEqual(first.pendingApprovals);

    const resumed = await agent.run({ approvals });
    expect(resumed.stopReason).toBe("end_turn");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("11. eviction keeps the request turn whole, so the resume still answers it", async () => {
    const { t } = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: [textResult("hi"), toolCallResult("t", { x: 1 }), textResult("done")],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { t },
      toolApproval: { t: "user-approval" },
      conversation: { maxMessages: 2 },
    });
    await agent.run("hello");
    const first = await agent.run("go");

    expect(agent.exportHistory().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const result = await agent.run({
      approvals: first.pendingApprovals!.map((p) => approve(p.approvalId)),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(agent.exportHistory().messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
  });

  it("12. a resume never summarises, even with keepRecentTurns 0 and history over budget", async () => {
    const summarizer = new MockLanguageModelV4({ doGenerate: [textResult("summary")] });
    const { agent, spy } = gatedAgent({
      context: { maxInputTokens: 1, summarize: { model: summarizer, keepRecentTurns: 0 } },
    });
    const first = await agent.run("go");

    const result = await agent.run({
      approvals: first.pendingApprovals!.map((p) => approve(p.approvalId)),
    });

    expect(summarizer.doGenerateCalls).toHaveLength(0);
    expect(result.stopReason).toBe("end_turn");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("14. a resume after ttlMs expiry throws INVALID_APPROVAL, not an SDK error", async () => {
    const { agent, model } = gatedAgent({ conversation: { ttlMs: 1 } });
    const first = await agent.run("go");
    await new Promise((r) => setTimeout(r, 10));

    await expect(
      agent.run({ approvals: first.pendingApprovals!.map((p) => approve(p.approvalId)) })
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_APPROVAL" }));
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("15. a resume skips onStart and attachments, and onComplete gets the resume result", async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const { agent, model } = gatedAgent({ onStart, onComplete });
    const first = await agent.run("go");

    const result = await agent.run(
      { approvals: first.pendingApprovals!.map((p) => approve(p.approvalId)) },
      { attachments: [{ type: "image", source: "base64", base64: "AAAA", mimeType: "image/png" }] }
    );

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("go");
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith(result);
    expect(result.stopReason).toBe("end_turn");
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).not.toContain("AAAA");
  });
});
