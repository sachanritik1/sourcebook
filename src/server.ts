import "dotenv/config";
import { createApp } from "./app";
import { createPool } from "./db/pool";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { createEmbeddingProvider } from "./ai/embeddings";
import { FixedWindowLimiter } from "./rate-limit/fixed-window";
import { createAnswerProvider } from "./ai/answers";
import {
  configuredRateLimit,
  configuredTrustProxyHops,
} from "./rate-limit/middleware";
import { QUEUE_NAME } from "./processing/types";
import { limitAnswers, limitEmbeddings } from "./ai/provider-budget";
import { configuredObjectStore } from "./storage/objects";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
const objects = configuredObjectStore();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");
const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
const baseEmbeddings = createEmbeddingProvider();
const baseAnswers = createAnswerProvider();
const embeddings =
  process.env.EMBEDDING_PROVIDER === "openai"
    ? limitEmbeddings(
        baseEmbeddings,
        new FixedWindowLimiter(
          redis,
          configuredRateLimit("EMBEDDING_REQUESTS_PER_MINUTE", 60),
          `provider-embedding:${baseEmbeddings.model}`,
        ),
      )
    : baseEmbeddings;
const answers =
  process.env.LLM_PROVIDER === "openai"
    ? limitAnswers(
        baseAnswers,
        new FixedWindowLimiter(
          redis,
          configuredRateLimit("ANSWER_REQUESTS_PER_MINUTE", 30),
          `provider-answer:${baseAnswers.model}`,
        ),
      )
    : baseAnswers;
const metricsToken = process.env.METRICS_TOKEN;
const metricsQueue = metricsToken
  ? new Queue(QUEUE_NAME, { connection: redis })
  : null;
const port = Number(process.env.PORT ?? 3000);
const server = createApp(pool, {
  objects,
  embeddings,
  limiter: new FixedWindowLimiter(redis, 10, "search-limit"),
  answers,
  answerLimiter: new FixedWindowLimiter(redis, 3, "question-limit"),
  publicLimiter: new FixedWindowLimiter(
    redis,
    configuredRateLimit("API_REQUESTS_PER_MINUTE", 120),
    "api-limit",
  ),
  authLimiter: new FixedWindowLimiter(
    redis,
    configuredRateLimit("AUTH_REQUESTS_PER_MINUTE", 10),
    "auth-limit",
  ),
  trustProxyHops: configuredTrustProxyHops(),
  metrics:
    metricsToken && metricsQueue
      ? { queue: metricsQueue, token: metricsToken }
      : undefined,
}).listen(port, () => console.info(`API listening on ${port}`));

async function shutdown() {
  server.close();
  await metricsQueue?.close();
  await pool.end();
  await redis.quit();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
