import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { generateStructured } from "./structured.js";

vi.mock("ai", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    generateObject: vi.fn(),
  };
});

import { generateObject } from "ai";
const mockGenerateObject = vi.mocked(generateObject);

const mockModel = { modelId: "test-model" } as Parameters<typeof generateStructured>[0]["model"];

const createMockResult = <T>(object: T, usage?: { inputTokens?: number; outputTokens?: number }) =>
  ({
    object,
    usage: {
      inputTokens: usage?.inputTokens ?? 50,
      outputTokens: usage?.outputTokens ?? 25,
    },
  }) as unknown as Awaited<ReturnType<typeof generateObject>>;

describe("generateStructured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed data matching schema", async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    mockGenerateObject.mockResolvedValue(
      createMockResult({ name: "Alice", age: 30 }, { inputTokens: 50, outputTokens: 25 })
    );

    const result = await generateStructured({
      model: mockModel,
      schema,
      prompt: "Extract person info",
    });

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);
  });

  it("passes image content when provided", async () => {
    const schema = z.object({ description: z.string() });

    mockGenerateObject.mockResolvedValue(
      createMockResult({ description: "A cat" }, { inputTokens: 100, outputTokens: 10 })
    );

    await generateStructured({
      model: mockModel,
      schema,
      prompt: "Describe this image",
      image: {
        base64: "aGVsbG8=",
        mimeType: "image/png",
      },
    });

    const callArgs = mockGenerateObject.mock.calls[0];
    expect(callArgs).toBeDefined();
    const messages = callArgs![0].messages as Array<{ content: unknown[] }>;

    expect(messages[0]!.content).toHaveLength(2);
    expect(messages[0]!.content[0]).toMatchObject({
      type: "image",
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
  });

  it("handles missing usage gracefully", async () => {
    const schema = z.object({ value: z.number() });

    mockGenerateObject.mockResolvedValue({
      object: { value: 42 },
      usage: {},
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const result = await generateStructured({
      model: mockModel,
      schema,
      prompt: "Get value",
    });

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it("passes abort signal to generateObject", async () => {
    const schema = z.object({ done: z.boolean() });
    const controller = new AbortController();

    mockGenerateObject.mockResolvedValue(
      createMockResult({ done: true }, { inputTokens: 10, outputTokens: 5 })
    );

    await generateStructured({
      model: mockModel,
      schema,
      prompt: "Check",
      signal: controller.signal,
    });

    const callArgs = mockGenerateObject.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs![0].abortSignal).toBe(controller.signal);
  });

  it("passes maxTokens to generateObject", async () => {
    const schema = z.object({ text: z.string() });

    mockGenerateObject.mockResolvedValue(
      createMockResult({ text: "hello" }, { inputTokens: 10, outputTokens: 5 })
    );

    await generateStructured({
      model: mockModel,
      schema,
      prompt: "Get text",
      maxTokens: 1000,
    });

    const callArgs = mockGenerateObject.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs![0].maxOutputTokens).toBe(1000);
  });
});
