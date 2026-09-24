import { gateway, type LanguageModel } from "ai";
import type { ProviderOptions, ThinkingConfig } from "../types.js";

const DEFAULT_THINKING_BUDGET_TOKENS = 10000;

/** String model ids resolve like the SDK does: through the global default provider, else the gateway. */
export function resolveModel(model: LanguageModel): Exclude<LanguageModel, string> {
  return typeof model === "string"
    ? (globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(model)
    : model;
}

export function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/** Merges per provider key, so caller options under `anthropic` do not wipe the `thinking` entry. */
export function mergeProviderOptions(
  base: ProviderOptions,
  extra: ProviderOptions
): ProviderOptions {
  const merged: ProviderOptions = { ...base };
  for (const [provider, options] of Object.entries(extra)) {
    merged[provider] = { ...merged[provider], ...options };
  }
  return merged;
}

export function buildProviderOptions(
  thinking: ThinkingConfig | undefined,
  extra: ProviderOptions | undefined
): ProviderOptions | undefined {
  const fromThinking: ProviderOptions | undefined = thinking
    ? {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: thinking.budgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS,
          },
        },
      }
    : undefined;

  return fromThinking || extra ? mergeProviderOptions(fromThinking ?? {}, extra ?? {}) : undefined;
}
