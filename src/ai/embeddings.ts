import { createHash } from "node:crypto";
import OpenAI from "openai";

export const EMBEDDING_DIMENSIONS = 1536;
export const INDEX_BATCH_SIZE = 32;

export type EmbeddingBatch = { vectors: number[][]; inputTokens: number };

export interface EmbeddingProvider {
  readonly model: string;
  readonly usdPerMillionTokens: number;
  embed(inputs: string[]): Promise<EmbeddingBatch>;
}

export function vectorLiteral(values: number[]): string {
  if (
    values.length !== EMBEDDING_DIMENSIONS ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Embedding must have ${EMBEDDING_DIMENSIONS} finite values`,
    );
  }
  if (!values.some((value) => value !== 0))
    throw new Error("Embedding cannot be zero");
  return `[${values.join(",")}]`;
}

export function estimatedCostUsd(
  tokens: number,
  usdPerMillionTokens: number,
): number {
  return Number(((tokens * usdPerMillionTokens) / 1_000_000).toFixed(8));
}

export class LocalLexicalEmbeddings implements EmbeddingProvider {
  readonly model = "local-lexical-v1";
  readonly usdPerMillionTokens = 0;

  async embed(inputs: string[]): Promise<EmbeddingBatch> {
    return {
      vectors: inputs.map((input) => {
        const values = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [input];
        for (const token of tokens) {
          const digest = createHash("sha256").update(token).digest();
          values[digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS]! += 1;
        }
        const length = Math.hypot(...values);
        return values.map((value) => value / length);
      }),
      inputTokens: inputs.reduce(
        (total, input) => total + Math.ceil(input.length / 4),
        0,
      ),
    };
  }
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly model = "text-embedding-3-small";
  readonly usdPerMillionTokens: number;
  private readonly client: OpenAI;

  constructor(apiKey: string, usdPerMillionTokens = 0.02) {
    if (!Number.isFinite(usdPerMillionTokens) || usdPerMillionTokens < 0)
      throw new Error("Embedding price must be nonnegative");
    this.usdPerMillionTokens = usdPerMillionTokens;
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
  }

  async embed(inputs: string[]): Promise<EmbeddingBatch> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: inputs,
      encoding_format: "float",
    });
    const vectors = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    if (vectors.length !== inputs.length)
      throw new Error(
        "Embedding provider returned the wrong number of vectors",
      );
    vectors.forEach(vectorLiteral);
    return { vectors, inputTokens: response.usage.prompt_tokens };
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER ?? "local";
  if (provider === "local") return new LocalLexicalEmbeddings();
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY)
      throw new Error(
        "OPENAI_API_KEY is required for EMBEDDING_PROVIDER=openai",
      );
    return new OpenAIEmbeddings(
      process.env.OPENAI_API_KEY,
      Number(process.env.EMBEDDING_USD_PER_MILLION_TOKENS ?? 0.02),
    );
  }
  throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
}

export function isProviderRateLimit(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 429;
}
