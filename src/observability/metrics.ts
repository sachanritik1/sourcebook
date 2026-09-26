import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { HttpError } from "../http/errors";

function validToken(provided: string | undefined, expected: string): boolean {
  const actual = provided?.startsWith("Bearer ") ? provided.slice(7) : "";
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function metricsRoutes(
  pool: Pool,
  queue: Pick<Queue, "getJobCounts">,
  token: string,
): Router {
  if (token.length < 32)
    throw new Error("METRICS_TOKEN must be at least 32 characters");
  const router = Router();
  router.get("/internal/metrics", async (req, res) => {
    if (!validToken(req.header("authorization"), token))
      throw new HttpError(401, "unauthorized", "Metrics token required");

    const [jobs, outbox, usage, queueCounts] = await Promise.all([
      pool.query(`SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        round(avg(extract(epoch from finished_at - created_at) * 1000)
          FILTER (WHERE finished_at IS NOT NULL))::bigint AS "averageEndToEndMs",
        coalesce(sum(greatest(attempts_made - 1, 0)), 0)::bigint AS "retryAttemptsCurrentEvent"
        FROM processing_jobs`),
      pool.query(`SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
        coalesce(sum(greatest(delivery_attempts - 1, 0)), 0)::bigint AS "publishRetries"
        FROM outbox_events`),
      pool.query(`SELECT
        count(*) FILTER (WHERE operation = 'llm_answer')::int AS "answerCalls",
        round(avg(provider_latency_ms) FILTER (WHERE operation = 'llm_answer'))::bigint AS "averageAnswerLatencyMs",
        coalesce(sum(input_tokens) FILTER (WHERE operation = 'llm_answer'), 0)::bigint AS "answerInputTokens",
        coalesce(sum(output_tokens) FILTER (WHERE operation = 'llm_answer'), 0)::bigint AS "answerOutputTokens",
        coalesce(sum(input_tokens) FILTER (WHERE operation <> 'llm_answer'), 0)::bigint AS "embeddingInputTokens"
        FROM usage_events`),
      queue.getJobCounts("waiting", "active", "delayed", "failed").catch(() => {
        throw new HttpError(
          503,
          "metrics_unavailable",
          "Queue metrics unavailable",
        );
      }),
    ]);
    const jobRow = jobs.rows[0];
    const outboxRow = outbox.rows[0];
    const usageRow = usage.rows[0];
    res.json({
      queue: queueCounts,
      outbox: {
        pending: Number(outboxRow.pending),
        publishRetries: Number(outboxRow.publishRetries),
      },
      jobs: {
        queued: Number(jobRow.queued),
        processing: Number(jobRow.processing),
        completed: Number(jobRow.completed),
        failed: Number(jobRow.failed),
        averageEndToEndMs:
          jobRow.averageEndToEndMs === null
            ? null
            : Number(jobRow.averageEndToEndMs),
        retryAttemptsCurrentEvent: Number(jobRow.retryAttemptsCurrentEvent),
      },
      usage: {
        answerCalls: Number(usageRow.answerCalls),
        averageAnswerLatencyMs:
          usageRow.averageAnswerLatencyMs === null
            ? null
            : Number(usageRow.averageAnswerLatencyMs),
        answerInputTokens: Number(usageRow.answerInputTokens),
        answerOutputTokens: Number(usageRow.answerOutputTokens),
        embeddingInputTokens: Number(usageRow.embeddingInputTokens),
      },
    });
  });
  return router;
}
