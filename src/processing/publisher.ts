import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import pino from "pino";
import { createPool } from "../db/pool";
import { createQueue } from "./queue";
import { documentEventSchema } from "./types";
import { recordFailure } from "./processor";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

type OutboxRow = { id: string; payload: unknown; max_attempts: number };

export async function publishPending(
  pool: Pool,
  queue: Pick<Queue, "add">,
  batchSize = 20,
): Promise<number> {
  const claimToken = randomUUID();
  const claimed = await pool.query<OutboxRow>(
    `WITH available AS (
       SELECT id FROM outbox_events
       WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
       ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE outbox_events o SET claim_token = $2, locked_until = now() + interval '30 seconds',
       delivery_attempts = delivery_attempts + 1
     FROM available a WHERE o.id = a.id
     RETURNING o.id, o.payload,
       (SELECT max_attempts FROM processing_jobs WHERE id = o.job_id) AS max_attempts`,
    [batchSize, claimToken],
  );
  for (const row of claimed.rows) {
    const event = documentEventSchema.parse(row.payload);
    try {
      await queue.add("document.process", event, {
        jobId: event.eventId,
        attempts: row.max_attempts,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
        removeOnFail: false,
      });
      await pool.query(
        "UPDATE outbox_events SET published_at = now(), claim_token = NULL, locked_until = NULL WHERE id = $1 AND claim_token = $2",
        [row.id, claimToken],
      );
      logger.info(
        {
          eventId: event.eventId,
          jobId: event.jobId,
          workspaceId: event.workspaceId,
          requestId: event.requestId,
        },
        "outbox event published",
      );
    } catch (error) {
      await pool.query(
        "UPDATE outbox_events SET claim_token = NULL, locked_until = now() + interval '5 seconds' WHERE id = $1 AND claim_token = $2",
        [row.id, claimToken],
      );
      logger.error({ err: error, eventId: row.id }, "outbox publish failed");
    }
  }
  return claimed.rows.length;
}

export async function reconcileJobs(
  pool: Pool,
  queue: Pick<Queue, "getJob">,
): Promise<number> {
  const result = await pool.query<{
    event_id: string;
    payload: unknown;
    max_attempts: number;
    job_id: string;
  }>(
    `SELECT o.id AS event_id, o.payload, j.max_attempts, j.id AS job_id FROM processing_jobs j
     JOIN outbox_events o ON o.id = j.current_event_id
     WHERE j.status IN ('queued', 'processing') AND o.published_at IS NOT NULL
       AND j.updated_at < now() - interval '2 minutes'
       AND (j.last_reconciled_at IS NULL OR j.last_reconciled_at < now() - interval '1 minute')
     ORDER BY COALESCE(j.last_reconciled_at, j.updated_at), j.id LIMIT 50`,
  );
  for (const row of result.rows) {
    const event = documentEventSchema.parse(row.payload);
    const bullJob = await queue.getJob(event.eventId);
    if (!bullJob) {
      // Redis may have lost a job after the outbox was marked published.
      await pool.query(
        "UPDATE outbox_events SET published_at = NULL WHERE id = $1 AND published_at IS NOT NULL",
        [event.eventId],
      );
      logger.warn(
        { eventId: event.eventId, jobId: event.jobId },
        "missing queue job scheduled for republish",
      );
    } else if ((await bullJob.getState()) === "failed") {
      await recordFailure(
        pool,
        event,
        row.max_attempts,
        row.max_attempts,
        new Error(bullJob.failedReason || "Queue job failed"),
      );
    }
    await pool.query(
      "UPDATE processing_jobs SET last_reconciled_at = now() WHERE id = $1 AND current_event_id = $2",
      [row.job_id, event.eventId],
    );
  }
  return result.rows.length;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl)
    throw new Error("DATABASE_URL and REDIS_URL are required");
  const pool = createPool(databaseUrl);
  const { queue, connection } = createQueue(redisUrl);
  let stopping = false;
  let polls = 0;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  try {
    while (!stopping) {
      try {
        await publishPending(pool, queue);
        if (++polls % 30 === 0) await reconcileJobs(pool, queue);
      } catch (error) {
        logger.error({ err: error }, "outbox poll failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await queue.close();
    await connection.quit();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ err: error }, "publisher stopped");
    process.exitCode = 1;
  });
}
