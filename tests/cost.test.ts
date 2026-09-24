import { describe, it, expect } from "vitest";
import type { LanguageModelUsage } from "ai";
import { costOf, sumCost } from "../src/cost.js";
import type { ModelPrice, PriceTable } from "../src/types.js";

function usage(over: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 1000,
    inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 500,
    outputTokenDetails: { textTokens: 500, reasoningTokens: 0 },
    totalTokens: 1500,
    ...over,
  };
}

const price: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };

describe("costOf", () => {
  it("prices input and output tokens", () => {
    const cost = costOf(usage(), price);

    // 1000 / 1e6 * 3 = 0.003; 500 / 1e6 * 15 = 0.0075
    expect(cost.inputUsd).toBeCloseTo(0.003, 10);
    expect(cost.outputUsd).toBeCloseTo(0.0075, 10);
    expect(cost.cacheReadUsd).toBe(0);
    expect(cost.cacheWriteUsd).toBe(0);
    expect(cost.totalUsd).toBeCloseTo(0.0105, 10);
    expect(cost.unpricedModels).toEqual([]);
  });

  it("bills reasoning tokens as output, since they are already counted in outputTokens", () => {
    const cost = costOf(
      usage({
        outputTokens: 800,
        outputTokenDetails: { textTokens: 500, reasoningTokens: 300 },
      }),
      price
    );

    // 800 / 1e6 * 15 = 0.012, no separate reasoning line item
    expect(cost.outputUsd).toBeCloseTo(0.012, 10);
  });

  it("falls back cache read/write pricing to the input price when not set", () => {
    const noCachePrice: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };
    const cost = costOf(
      usage({
        inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50 },
      }),
      noCachePrice
    );

    // cacheRead 100 / 1e6 * 3 = 0.0003; cacheWrite 50 / 1e6 * 3 = 0.00015
    expect(cost.cacheReadUsd).toBeCloseTo(0.0003, 10);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.00015, 10);
  });

  it("uses each price's own cache rates when set", () => {
    const cost = costOf(
      usage({
        inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50 },
      }),
      price
    );

    // cacheRead 100 / 1e6 * 0.3 = 0.00003; cacheWrite 50 / 1e6 * 3.75 = 0.0001875
    expect(cost.cacheReadUsd).toBeCloseTo(0.00003, 10);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.0001875, 10);
  });

  it("treats undefined usage fields as zero", () => {
    const cost = costOf(
      {
        inputTokens: undefined,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      },
      price
    );

    expect(cost).toEqual({
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      totalUsd: 0,
      unpricedModels: [],
    });
  });
});

describe("sumCost", () => {
  it("sums cost across steps keyed by modelId", () => {
    const table: PriceTable = { "claude-sonnet-5": price };
    const steps = [
      { model: { modelId: "claude-sonnet-5" }, usage: usage() },
      { model: { modelId: "claude-sonnet-5" }, usage: usage({ outputTokens: 100, outputTokenDetails: { textTokens: 100, reasoningTokens: 0 } }) },
    ];

    const cost = sumCost(steps, table);

    // step1: input 0.003, output 0.0075 -> 0.0105; step2: input 0.003, output 0.0015 -> 0.0045
    expect(cost.inputUsd).toBeCloseTo(0.006, 10);
    expect(cost.outputUsd).toBeCloseTo(0.009, 10);
    expect(cost.totalUsd).toBeCloseTo(0.015, 10);
    expect(cost.unpricedModels).toEqual([]);
  });

  it("excludes steps whose model has no table entry and lists them in unpricedModels", () => {
    const table: PriceTable = { "claude-sonnet-5": price };
    const steps = [
      { model: { modelId: "claude-sonnet-5" }, usage: usage() },
      { model: { modelId: "claude-haiku-5" }, usage: usage() },
    ];

    const cost = sumCost(steps, table);

    expect(cost.totalUsd).toBeCloseTo(0.0105, 10);
    expect(cost.unpricedModels).toEqual(["claude-haiku-5"]);
  });

  it("returns all zeros for an empty steps list", () => {
    const cost = sumCost([], {});
    expect(cost).toEqual({
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      totalUsd: 0,
      unpricedModels: [],
    });
  });
});
