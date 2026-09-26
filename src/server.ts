import "dotenv/config";
import { createApp } from "./app";
import { createPool } from "./db/pool";
import IORedis from "ioredis";
import { createEmbeddingProvider } from "./ai/embeddings";
import { SearchLimiter } from "./ai/search-limiter";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
const embeddings = createEmbeddingProvider();
const port = Number(process.env.PORT ?? 3000);
const server = createApp(pool, {
  embeddings,
  limiter: new SearchLimiter(redis),
}).listen(port, () => console.info(`API listening on ${port}`));

async function shutdown() {
  server.close();
  await pool.end();
  await redis.quit();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
