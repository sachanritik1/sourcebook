import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth/sessions";
import { HttpError } from "../http/errors";
import type { Response } from "express";
import {
  estimatedCostUsd,
  isProviderRateLimit,
  isProviderQuotaError,
  providerRetryAfterSeconds,
  vectorLiteral,
  type EmbeddingProvider,
} from "./embeddings";
import type { RateCounter } from "../rate-limit/fixed-window";
import { retrieveChunks } from "./retrieval";
import {
  answerCostUsd,
  citedAnswer,
  INSUFFICIENT_EVIDENCE,
  InvalidCitationError,
  type AnswerProvider,
} from "./answers";
import { ProviderBudgetError } from "./provider-budget";
import {
  completeQuestion,
  forgetQuestion,
  markQuestionUncertain,
  questionFingerprint,
  reserveQuestion,
} from "./question-requests";

function rethrowProviderError(
  error: unknown,
  res: Response,
  code: string,
  message: string,
): never {
  if (error instanceof ProviderBudgetError) {
    res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    throw new HttpError(
      503,
      error.reason === "exhausted"
        ? "provider_budget_exhausted"
        : "provider_budget_unavailable",
      "Provider request capacity temporarily unavailable",
    );
  }
  if (isProviderQuotaError(error))
    throw new HttpError(
      503,
      "provider_quota_exhausted",
      "Provider account quota requires operator action",
    );
  if (isProviderRateLimit(error)) {
    res.setHeader("Retry-After", String(providerRetryAfterSeconds(error)));
    throw new HttpError(503, code, message);
  }
  throw error;
}

const searchBody = z
  .object({
    query: z.string().trim().min(1).max(2000),
    topK: z.number().int().min(1).max(10).default(5),
  })
  .strict();

async function requireWorkspaceBudget(
  counter: RateCounter,
  workspaceId: string,
  res: Response,
  code: string,
  message: string,
): Promise<void> {
  let allowed;
  try {
    allowed = await counter.take(workspaceId);
  } catch {
    throw new HttpError(
      503,
      "rate_limit_unavailable",
      "AI endpoints temporarily unavailable",
    );
  }
  if (!allowed) {
    res.setHeader("Retry-After", "60");
    throw new HttpError(429, code, message);
  }
}

export function aiRoutes(
  pool: Pool,
  embeddings: EmbeddingProvider,
  limiter: RateCounter,
  answers?: AnswerProvider,
  answerLimiter?: RateCounter,
): Router {
  const router = Router();
  router.use(requireUser(pool));

  router.post("/:workspaceId/search", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const { query, topK } = searchBody.parse(req.body);
    const membership = await pool.query(
      "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, res.locals.userId],
    );
    if (!membership.rowCount)
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    await requireWorkspaceBudget(
      limiter,
      workspaceId,
      res,
      "search_rate_limited",
      "Search limit reached for this workspace",
    );

    const started = Date.now();
    let embedding;
    try {
      embedding = await embeddings.embed([query]);
    } catch (error) {
      rethrowProviderError(
        error,
        res,
        "embedding_provider_busy",
        "Embedding provider is rate limited",
      );
    }
    if (
      embedding.vectors.length !== 1 ||
      !Number.isInteger(embedding.inputTokens) ||
      embedding.inputTokens < 0
    )
      throw new Error("Embedding provider returned invalid search response");
    const vector = vectorLiteral(embedding.vectors[0]!);
    const chunks = await retrieveChunks(
      pool,
      workspaceId,
      res.locals.userId,
      embeddings.model,
      vector,
      topK,
    );
    await pool.query(
      `INSERT INTO usage_events (workspace_id, event_key, operation, model, input_tokens, estimated_cost_usd)
       VALUES ($1, $2, 'embedding_search', $3, $4, $5)`,
      [
        workspaceId,
        randomUUID(),
        embeddings.model,
        embedding.inputTokens,
        estimatedCostUsd(embedding.inputTokens, embeddings.usdPerMillionTokens),
      ],
    );
    req.log.info(
      {
        workspaceId,
        model: embeddings.model,
        chunks: chunks.length,
        embeddingLatencyMs: Date.now() - started,
      },
      "vector search completed",
    );
    res.json({ model: embeddings.model, results: chunks });
  });

  if (answers && answerLimiter)
    router.post("/:workspaceId/questions", async (req, res) => {
      const workspaceId = z.uuid().parse(req.params.workspaceId);
      const key = z.uuid().safeParse(req.get("Idempotency-Key"));
      if (!key.success)
        throw new HttpError(
          400,
          "invalid_idempotency_key",
          "Idempotency-Key must be a UUID",
        );
      const { question, topK } = z
        .object({
          question: z.string().trim().min(1).max(2000),
          topK: z.number().int().min(1).max(10).default(5),
        })
        .strict()
        .parse(req.body);
      const membership = await pool.query(
        "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, res.locals.userId],
      );
      if (!membership.rowCount)
        throw new HttpError(404, "workspace_not_found", "Workspace not found");
      const reservation = await reserveQuestion(
        pool,
        workspaceId,
        res.locals.userId,
        key.data,
        questionFingerprint(question, topK),
      );
      if (!reservation.fresh) {
        res.json(reservation.response);
        return;
      }
      let providerMayHaveRun = false;
      try {
        await requireWorkspaceBudget(
          answerLimiter,
          workspaceId,
          res,
          "question_rate_limited",
          "Question limit reached for this workspace",
        );
        providerMayHaveRun = true;
        let queryEmbedding;
        try {
          queryEmbedding = await embeddings.embed([question]);
        } catch (error) {
          rethrowProviderError(
            error,
            res,
            "embedding_provider_busy",
            "Embedding provider is rate limited",
          );
        }
        if (
          queryEmbedding.vectors.length !== 1 ||
          !Number.isInteger(queryEmbedding.inputTokens) ||
          queryEmbedding.inputTokens < 0
        )
          throw new Error(
            "Embedding provider returned invalid search response",
          );
        const chunks = await retrieveChunks(
          pool,
          workspaceId,
          res.locals.userId,
          embeddings.model,
          vectorLiteral(queryEmbedding.vectors[0]!),
          topK,
        );
        await pool.query(
          `INSERT INTO usage_events (workspace_id, event_key, operation, model, input_tokens, estimated_cost_usd)
           VALUES ($1, $2, 'embedding_search', $3, $4, $5)`,
          [
            workspaceId,
            `${key.data}:embedding`,
            embeddings.model,
            queryEmbedding.inputTokens,
            estimatedCostUsd(
              queryEmbedding.inputTokens,
              embeddings.usdPerMillionTokens,
            ),
          ],
        );
        if (chunks.length === 0) {
          const response = {
            answer: INSUFFICIENT_EVIDENCE,
            citations: [],
            model: answers.model,
          };
          // The embedding usage is already durable; this stores the replayable result.
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await completeQuestion(client, workspaceId, key.data, response);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          res.json(response);
          return;
        }
        const llmStarted = Date.now();
        req.log.info(
          {
            workspaceId,
            questionKey: key.data,
            model: answers.model,
            retrievedChunks: chunks.length,
          },
          "answer provider request",
        );
        let draft;
        try {
          draft = await answers.answer(question, chunks);
        } catch (error) {
          rethrowProviderError(
            error,
            res,
            "llm_provider_busy",
            "Answer provider is rate limited",
          );
        }
        const llmLatencyMs = Date.now() - llmStarted;
        let grounded;
        let invalidCitation = false;
        try {
          grounded = citedAnswer(draft, chunks);
        } catch (error) {
          if (!(error instanceof InvalidCitationError)) throw error;
          invalidCitation = true;
        }
        const response = grounded && { ...grounded, model: answers.model };
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO usage_events (workspace_id, event_key, operation, model, input_tokens, output_tokens, estimated_cost_usd, provider_latency_ms)
             VALUES ($1, $2, 'llm_answer', $3, $4, $5, $6, $7)`,
            [
              workspaceId,
              `${key.data}:answer`,
              answers.model,
              draft.inputTokens,
              draft.outputTokens,
              answerCostUsd(draft, answers),
              llmLatencyMs,
            ],
          );
          if (response)
            await completeQuestion(client, workspaceId, key.data, response);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        if (invalidCitation)
          throw new HttpError(
            502,
            "invalid_provider_citation",
            "Answer provider returned an invalid citation",
          );
        req.log.info(
          {
            workspaceId,
            questionKey: key.data,
            model: answers.model,
            citationCount: grounded!.citations.length,
            llmLatencyMs,
            llmInputTokens: draft.inputTokens,
            llmOutputTokens: draft.outputTokens,
          },
          "grounded answer completed",
        );
        res.json(response);
      } catch (error) {
        if (providerMayHaveRun)
          await markQuestionUncertain(pool, workspaceId, key.data);
        else await forgetQuestion(pool, workspaceId, key.data);
        throw error;
      }
    });

  router.get("/:workspaceId/usage", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const result = await pool.query(
      `SELECT u.operation, u.model, coalesce(sum(u.input_tokens), 0)::bigint AS "inputTokens",
              coalesce(sum(u.output_tokens), 0)::bigint AS "outputTokens",
              coalesce(sum(u.estimated_cost_usd), 0)::text AS "estimatedCostUsd"
       FROM usage_events u
       WHERE u.workspace_id = $1
         AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = u.workspace_id AND m.user_id = $2)
       GROUP BY u.operation, u.model ORDER BY u.operation, u.model`,
      [workspaceId, res.locals.userId],
    );
    const membership = await pool.query(
      "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, res.locals.userId],
    );
    if (!membership.rowCount)
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    res.json({ usage: result.rows });
  });

  return router;
}
