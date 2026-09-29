import "dotenv/config";
import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import type { Pool } from "pg";
import {
  createEmbeddingProvider,
  isProviderQuotaError,
  type EmbeddingProvider,
} from "../ai/embeddings";
import { limitEmbeddings, ProviderBudgetError } from "../ai/provider-budget";
import { createPool } from "../db/pool";
import { FixedWindowLimiter } from "../rate-limit/fixed-window";
import { configuredRateLimit } from "../rate-limit/middleware";
import {
  processDocumentEvent,
  recordFailure,
  WorkspaceBusyError,
} from "./processor";
import { documentEventSchema, QUEUE_NAME, type DocumentEvent } from "./types";
import { providerAwareBackoff } from "./backoff";
import { configuredObjectStore, type ObjectStore } from "../storage/objects";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export async function processQueuedDocument(
  pool: Pool,
  job: Job<DocumentEvent>,
  token: string | undefined,
  embeddings: EmbeddingProvider,
  objects?: ObjectStore,
): Promise<void> {
  const event = documentEventSchema.parse(job.data);
  const attempt = job.attemptsMade + 1;
  try {
    await processDocumentEvent(pool, event, attempt, embeddings, objects);
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
    if (
      error instanceof WorkspaceBusyError ||
      error instanceof ProviderBudgetError
    ) {
      const delay =
        error instanceof ProviderBudgetError ? error.retryAfterMs : 1000;
      await job.moveToDelayed(Date.now() + delay, token);
      logger.warn(
        {
          eventId: event.eventId,
          jobId: event.jobId,
          workspaceId: event.workspaceId,
          requestId: event.requestId,
          attempt,
          delayMs: delay,
          reason: error.message,
        },
        "document processing deferred",
      );
      throw new DelayedError();
    }
    const quotaFailure = isProviderQuotaError(error);
    await recordFailure(
      pool,
      event,
      attempt,
      quotaFailure ? attempt : (job.opts.attempts ?? 1),
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
    if (quotaFailure)
      throw new UnrecoverableError("Provider quota requires operator action");
    throw error;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl)
    throw new Error("DATABASE_URL and REDIS_URL are required");
  const pool = createPool(databaseUrl);
  const objects = configuredObjectStore();
  const baseEmbeddings = createEmbeddingProvider();
  const budgetConnection =
    process.env.EMBEDDING_PROVIDER === "openai"
      ? new IORedis(redisUrl, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        })
      : null;
  const embeddings = budgetConnection
    ? limitEmbeddings(
        baseEmbeddings,
        new FixedWindowLimiter(
          budgetConnection,
          configuredRateLimit("EMBEDDING_REQUESTS_PER_MINUTE", 60),
          `provider-embedding:${baseEmbeddings.model}`,
        ),
      )
    : baseEmbeddings;
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker(
    QUEUE_NAME,
    (job, token) =>
      processQueuedDocument(pool, job, token, embeddings, objects),
    {
      connection,
      concurrency: 4,
      maxStalledCount: 2,
      settings: { backoffStrategy: providerAwareBackoff },
    },
  );
  worker.on("error", (error) => logger.error({ err: error }, "worker error"));
  worker.on("failed", (job, error) =>
    logger.error({ err: error, bullJobId: job?.id }, "BullMQ job failed"),
  );
  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await budgetConnection?.quit();
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
