import "dotenv/config";
import { DelayedError, Worker } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { createPool } from "../db/pool";
import {
  processDocumentEvent,
  recordFailure,
  WorkspaceBusyError,
} from "./processor";
import { documentEventSchema, QUEUE_NAME } from "./types";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl)
    throw new Error("DATABASE_URL and REDIS_URL are required");
  const pool = createPool(databaseUrl);
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker(
    QUEUE_NAME,
    async (job, token) => {
      const event = documentEventSchema.parse(job.data);
      const attempt = job.attemptsMade + 1;
      try {
        await processDocumentEvent(pool, event, attempt);
        logger.info(
          {
            eventId: event.eventId,
            jobId: event.jobId,
            workspaceId: event.workspaceId,
            requestId: event.requestId,
            attempt,
          },
          "document processed",
        );
      } catch (error) {
        if (error instanceof WorkspaceBusyError) {
          await job.moveToDelayed(Date.now() + 1000, token);
          throw new DelayedError();
        }
        await recordFailure(
          pool,
          event,
          attempt,
          job.opts.attempts ?? 1,
          error,
        );
        logger.error(
          {
            err: error,
            eventId: event.eventId,
            jobId: event.jobId,
            workspaceId: event.workspaceId,
            requestId: event.requestId,
            attempt,
          },
          "document processing failed",
        );
        throw error;
      }
    },
    { connection, concurrency: 4, maxStalledCount: 2 },
  );
  worker.on("error", (error) => logger.error({ err: error }, "worker error"));
  worker.on("failed", (job, error) =>
    logger.error({ err: error, bullJobId: job?.id }, "BullMQ job failed"),
  );
  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await pool.end();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ err: error }, "worker stopped");
    process.exitCode = 1;
  });
}
