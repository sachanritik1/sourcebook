import "dotenv/config";
import { createApp } from "./app";
import { createPool } from "./db/pool";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
const port = Number(process.env.PORT ?? 3000);
const server = createApp(pool).listen(port, () =>
  console.info(`API listening on ${port}`),
);

async function shutdown() {
  server.close();
  await pool.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
