import type { RateCounter } from "../rate-limit/fixed-window";
import type { AnswerProvider } from "./answers";
import type { EmbeddingProvider } from "./embeddings";

export class ProviderBudgetError extends Error {
  constructor(
    readonly reason: "exhausted" | "unavailable",
    readonly retryAfterMs: number,
  ) {
    super(`Provider request budget ${reason}`);
  }
}

async function reserve(counter: RateCounter): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await counter.take("shared");
  } catch {
    throw new ProviderBudgetError("unavailable", 5_000);
  }
  if (!allowed) {
    const untilNextMinute = 60_000 - (Date.now() % 60_000);
    throw new ProviderBudgetError(
      "exhausted",
      untilNextMinute + Math.floor(Math.random() * 1_000),
    );
  }
}

export function limitEmbeddings(
  provider: EmbeddingProvider,
  counter: RateCounter,
): EmbeddingProvider {
  return {
    model: provider.model,
    usdPerMillionTokens: provider.usdPerMillionTokens,
    async embed(inputs) {
      await reserve(counter);
      return provider.embed(inputs);
    },
  };
}

export function limitAnswers(
  provider: AnswerProvider,
  counter: RateCounter,
): AnswerProvider {
  return {
    model: provider.model,
    inputUsdPerMillionTokens: provider.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: provider.outputUsdPerMillionTokens,
    async answer(question, chunks) {
      await reserve(counter);
      return provider.answer(question, chunks);
    },
  };
}
