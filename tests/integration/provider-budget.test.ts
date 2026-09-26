import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import IORedis from "ioredis";
import {
  isProviderQuotaError,
  LocalLexicalEmbeddings,
  providerRetryAfterSeconds,
} from "../../src/ai/embeddings";
import {
  limitAnswers,
  limitEmbeddings,
  ProviderBudgetError,
} from "../../src/ai/provider-budget";
import { FixedWindowLimiter } from "../../src/rate-limit/fixed-window";
import {
  PROVIDER_AWARE_BACKOFF,
  providerAwareBackoff,
} from "../../src/processing/backoff";

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)("shared provider budgets", () => {
  const redis = redisUrl ? new IORedis(redisUrl) : null;
  afterAll(async () => {
    await redis?.quit();
  });

  it("shares an embedding limit across independent callers and keeps answer capacity separate", async () => {
    const prefix = `provider-test:${randomUUID()}`;
    let embeddingCalls = 0;
    const base = new LocalLexicalEmbeddings();
    const provider = {
      model: base.model,
      usdPerMillionTokens: 0,
      embed: async (inputs: string[]) => {
        embeddingCalls++;
        return base.embed(inputs);
      },
    };
    const api = limitEmbeddings(
      provider,
      new FixedWindowLimiter(redis!, 1, prefix),
    );
    const worker = limitEmbeddings(
      provider,
      new FixedWindowLimiter(redis!, 1, prefix),
    );
    await api.embed(["first"]);
    await expect(worker.embed(["second"])).rejects.toMatchObject({
      reason: "exhausted",
    });
    expect(embeddingCalls).toBe(1);

    let answerCalls = 0;
    const answer = limitAnswers(
      {
        model: "test-answer",
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
        answer: async () => {
          answerCalls++;
          return {
            answer: "done",
            insufficientEvidence: false,
            citations: [1],
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      },
      new FixedWindowLimiter(redis!, 1, `${prefix}:answer`),
    );
    await answer.answer("question", []);
    expect(answerCalls).toBe(1);
  });

  it("fails closed before a provider call when the budget store fails", async () => {
    let calls = 0;
    const provider = limitEmbeddings(
      {
        model: "test",
        usdPerMillionTokens: 0,
        embed: async () => {
          calls++;
          return { vectors: [], inputTokens: 0 };
        },
      },
      {
        take: async () => {
          throw new Error("Redis unavailable");
        },
      },
    );
    await expect(provider.embed(["test"])).rejects.toBeInstanceOf(
      ProviderBudgetError,
    );
    expect(calls).toBe(0);
  });

  it("honors a provider Retry-After header", () => {
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: new Headers({ "retry-after": "47" }),
    });
    expect(providerRetryAfterSeconds(error)).toBe(47);
    expect(providerRetryAfterSeconds(new Error("other"))).toBe(30);
    const delay = providerAwareBackoff(1, PROVIDER_AWARE_BACKOFF, error);
    expect(delay).toBeGreaterThanOrEqual(47_000);
    expect(delay).toBeLessThan(48_000);
    const ordinary = providerAwareBackoff(
      2,
      PROVIDER_AWARE_BACKOFF,
      new Error("temporary"),
    );
    expect(ordinary).toBeGreaterThanOrEqual(2_000);
    expect(ordinary).toBeLessThan(3_000);
    const quota = Object.assign(new Error("credits exhausted"), {
      status: 429,
      code: "credit_balance_exhausted",
    });
    expect(isProviderQuotaError(quota)).toBe(true);
    expect(isProviderQuotaError(error)).toBe(false);
  });
});
