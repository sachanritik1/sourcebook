import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "./pool";

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(71042026)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir(join(process.cwd(), "migrations")))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const existing = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (existing.rowCount) continue;
      const sql = await readFile(
        join(process.cwd(), "migrations", file),
        "utf8",
      );
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.info(`Applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(71042026)");
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  migrate(databaseUrl).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
