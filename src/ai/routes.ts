import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth/sessions";
import { HttpError } from "../http/errors";
import {
  estimatedCostUsd,
  isProviderRateLimit,
  vectorLiteral,
  type EmbeddingProvider,
} from "./embeddings";
import { SearchLimiter } from "./search-limiter";

const searchBody = z
  .object({
    query: z.string().trim().min(1).max(2000),
    topK: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export function aiRoutes(
  pool: Pool,
  embeddings: EmbeddingProvider,
  limiter: SearchLimiter,
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
    if (!(await limiter.take(workspaceId))) {
      res.setHeader("Retry-After", "60");
      throw new HttpError(
        429,
        "search_rate_limited",
        "Search limit reached for this workspace",
      );
    }

    const started = Date.now();
    let embedding;
    try {
      embedding = await embeddings.embed([query]);
    } catch (error) {
      if (isProviderRateLimit(error)) {
        res.setHeader("Retry-After", "30");
        throw new HttpError(
          503,
          "embedding_provider_busy",
          "Embedding provider is rate limited",
        );
      }
      throw error;
    }
    if (
      embedding.vectors.length !== 1 ||
      !Number.isInteger(embedding.inputTokens) ||
      embedding.inputTokens < 0
    )
      throw new Error("Embedding provider returned invalid search response");
    const vector = vectorLiteral(embedding.vectors[0]!);
    const result = await pool.query(
      `SELECT c.id AS "chunkId", c.document_id AS "documentId", d.filename,
              c.ordinal, c.content, 1 - (e.embedding <=> $3::vector) AS score
       FROM document_embeddings e
       JOIN document_chunks c ON c.workspace_id = e.workspace_id AND c.id = e.chunk_id
       JOIN documents d ON d.workspace_id = c.workspace_id AND d.id = c.document_id
       WHERE e.workspace_id = $1 AND e.model = $4 AND d.status = 'completed'
         AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = e.workspace_id AND m.user_id = $2)
       ORDER BY e.embedding <=> $3::vector, c.id
       LIMIT $5`,
      [workspaceId, res.locals.userId, vector, embeddings.model, topK],
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
        chunks: result.rowCount,
        embeddingLatencyMs: Date.now() - started,
      },
      "vector search completed",
    );
    res.json({ model: embeddings.model, results: result.rows });
  });

  router.get("/:workspaceId/usage", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const result = await pool.query(
      `SELECT u.operation, u.model, coalesce(sum(u.input_tokens), 0)::bigint AS "inputTokens",
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
