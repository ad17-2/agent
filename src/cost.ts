import type { LanguageModelUsage } from "ai";
import type { Cost, ModelPrice, PriceTable } from "./types.js";

const PER_MILLION = 1_000_000;

/** Prices one step's usage. Reasoning tokens are already included in `outputTokens`, so they bill as output. */
export function costOf(usage: LanguageModelUsage, price: ModelPrice): Cost {
  const noCacheTokens = usage.inputTokenDetails?.noCacheTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  const inputUsd = (noCacheTokens / PER_MILLION) * price.inputPerMTok;
  const outputUsd = (outputTokens / PER_MILLION) * price.outputPerMTok;
  const cacheReadUsd =
    (cacheReadTokens / PER_MILLION) * (price.cacheReadPerMTok ?? price.inputPerMTok);
  const cacheWriteUsd =
    (cacheWriteTokens / PER_MILLION) * (price.cacheWritePerMTok ?? price.inputPerMTok);

  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    unpricedModels: [],
  };
}

/** Sums cost across steps, keyed by each step's model.modelId. Steps whose model has no table entry are excluded from totalUsd and listed in unpricedModels. */
export function sumCost(
  steps: ReadonlyArray<{ model: { modelId: string }; usage: LanguageModelUsage }>,
  table: PriceTable
): Cost {
  const total = { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0 };
  const unpriced = new Set<string>();

  for (const step of steps) {
    const price = table[step.model.modelId];
    if (!price) {
      unpriced.add(step.model.modelId);
      continue;
    }

    const stepCost = costOf(step.usage, price);
    total.inputUsd += stepCost.inputUsd;
    total.outputUsd += stepCost.outputUsd;
    total.cacheReadUsd += stepCost.cacheReadUsd;
    total.cacheWriteUsd += stepCost.cacheWriteUsd;
    total.totalUsd += stepCost.totalUsd;
  }

  return { ...total, unpricedModels: [...unpriced] };
}

export function addCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputUsd: a.inputUsd + b.inputUsd,
    outputUsd: a.outputUsd + b.outputUsd,
    cacheReadUsd: a.cacheReadUsd + b.cacheReadUsd,
    cacheWriteUsd: a.cacheWriteUsd + b.cacheWriteUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    unpricedModels: [...new Set([...a.unpricedModels, ...b.unpricedModels])],
  };
}
