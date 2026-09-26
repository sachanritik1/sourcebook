import "dotenv/config";
import { createApp } from "./app";
import { createPool } from "./db/pool";
import IORedis from "ioredis";
import { createEmbeddingProvider } from "./ai/embeddings";
import { FixedWindowLimiter } from "./rate-limit/fixed-window";
import { createAnswerProvider } from "./ai/answers";
import {
  configuredRateLimit,
  configuredTrustProxyHops,
} from "./rate-limit/middleware";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");
const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
const embeddings = createEmbeddingProvider();
const answers = createAnswerProvider();
const port = Number(process.env.PORT ?? 3000);
const server = createApp(pool, {
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
}).listen(port, () => console.info(`API listening on ${port}`));

async function shutdown() {
  server.close();
  await pool.end();
  await redis.quit();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
