import type { Pool, PoolClient } from "pg";
import {
  INDEX_BATCH_SIZE,
  estimatedCostUsd,
  vectorLiteral,
  type EmbeddingProvider,
} from "../ai/embeddings";
import { chunkText } from "./chunks";
import { extractText } from "./extract";
import type { DocumentEvent } from "./types";

export class WorkspaceBusyError extends Error {}

type StoredDocument = {
  content: Buffer;
  media_type: string;
  current_event_id: string;
  status: string;
};

async function setProgress(
  client: PoolClient,
  event: DocumentEvent,
  stage: string,
  progress: number,
  attempt: number,
) {
  await client.query(
    `UPDATE processing_jobs SET status = 'processing', stage = $3, progress = $4,
       attempts_made = $5, updated_at = now() WHERE id = $1 AND current_event_id = $2`,
    [event.jobId, event.eventId, stage, progress, attempt],
  );
  await client.query(
    "UPDATE documents SET status = 'processing', updated_at = now() WHERE id = $1 AND workspace_id = $2",
    [event.documentId, event.workspaceId],
  );
}

export async function processDocumentEvent(
  pool: Pool,
  event: DocumentEvent,
  attempt: number,
  embeddings: EmbeddingProvider,
): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
      [event.workspaceId],
    );
    locked = lock.rows[0]?.acquired ?? false;
    if (!locked)
      throw new WorkspaceBusyError("Workspace already has a processing job");

    const result = await client.query<StoredDocument>(
      `SELECT d.content, d.media_type, j.current_event_id, j.status
       FROM processing_jobs j JOIN documents d ON d.workspace_id = j.workspace_id AND d.id = j.document_id
       WHERE j.id = $1 AND j.workspace_id = $2 AND j.document_id = $3`,
      [event.jobId, event.workspaceId, event.documentId],
    );
    const document = result.rows[0];
    if (
      !document ||
      document.current_event_id !== event.eventId ||
      document.status === "completed"
    )
      return;
    const processed = await client.query(
      "SELECT 1 FROM processed_events WHERE event_id = $1",
      [event.eventId],
    );
    if (processed.rowCount) return;

    const existingChunks = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM document_chunks WHERE workspace_id = $1 AND document_id = $2",
      [event.workspaceId, event.documentId],
    );
    if (Number(existingChunks.rows[0]?.count) === 0) {
      await setProgress(client, event, "extracting", 20, attempt);
      const text = await extractText(document.content, document.media_type);
      await setProgress(client, event, "chunking", 50, attempt);
      const chunks = chunkText(text);
      if (chunks.length > 500)
        throw new Error("Document exceeds the 500-chunk indexing limit");
      await client.query("BEGIN");
      try {
        const current = await client.query<{ current_event_id: string }>(
          "SELECT current_event_id FROM processing_jobs WHERE id = $1 FOR UPDATE",
          [event.jobId],
        );
        if (current.rows[0]?.current_event_id !== event.eventId) {
          await client.query("ROLLBACK");
          return;
        }
        for (const [ordinal, content] of chunks.entries()) {
          await client.query(
            "INSERT INTO document_chunks (workspace_id, document_id, ordinal, content) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, document_id, ordinal) DO NOTHING",
            [event.workspaceId, event.documentId, ordinal, content],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const totalResult = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM document_chunks WHERE workspace_id = $1 AND document_id = $2",
      [event.workspaceId, event.documentId],
    );
    const totalChunks = Number(totalResult.rows[0]?.count);
    if (totalChunks === 0 || totalChunks > 500)
      throw new Error(
        "Document has no indexable chunks or exceeds the 500-chunk limit",
      );
    await setProgress(client, event, "embedding", 60, attempt);

    while (true) {
      const missing = await client.query<{
        id: string;
        ordinal: number;
        content: string;
      }>(
        `SELECT c.id, c.ordinal, c.content FROM document_chunks c
         LEFT JOIN document_embeddings e ON e.workspace_id = c.workspace_id AND e.chunk_id = c.id AND e.model = $3
         WHERE c.workspace_id = $1 AND c.document_id = $2 AND e.chunk_id IS NULL
         ORDER BY c.ordinal LIMIT $4`,
        [
          event.workspaceId,
          event.documentId,
          embeddings.model,
          INDEX_BATCH_SIZE,
        ],
      );
      if (missing.rows.length === 0) break;
      const response = await embeddings.embed(
        missing.rows.map((row) => row.content),
      );
      if (
        response.vectors.length !== missing.rows.length ||
        !Number.isInteger(response.inputTokens) ||
        response.inputTokens < 0
      )
        throw new Error(
          "Embedding provider returned invalid usage or vector count",
        );
      response.vectors.forEach(vectorLiteral);
      await client.query("BEGIN");
      try {
        const current = await client.query<{ current_event_id: string }>(
          "SELECT current_event_id FROM processing_jobs WHERE id = $1 FOR UPDATE",
          [event.jobId],
        );
        if (current.rows[0]?.current_event_id !== event.eventId) {
          await client.query("ROLLBACK");
          return;
        }
        for (const [index, row] of missing.rows.entries()) {
          await client.query(
            "INSERT INTO document_embeddings (workspace_id, chunk_id, model, embedding) VALUES ($1, $2, $3, $4::vector) ON CONFLICT DO NOTHING",
            [
              event.workspaceId,
              row.id,
              embeddings.model,
              vectorLiteral(response.vectors[index]!),
            ],
          );
        }
        await client.query(
          `INSERT INTO usage_events (workspace_id, job_id, event_key, operation, model, input_tokens, estimated_cost_usd)
           VALUES ($1, $2, $3, 'embedding_index', $4, $5, $6) ON CONFLICT (event_key) DO NOTHING`,
          [
            event.workspaceId,
            event.jobId,
            `${event.eventId}:batch:${missing.rows[0]!.ordinal}`,
            embeddings.model,
            response.inputTokens,
            estimatedCostUsd(
              response.inputTokens,
              embeddings.usdPerMillionTokens,
            ),
          ],
        );
        const indexed = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM document_embeddings e
           JOIN document_chunks c ON c.workspace_id = e.workspace_id AND c.id = e.chunk_id
           WHERE c.workspace_id = $1 AND c.document_id = $2 AND e.model = $3`,
          [event.workspaceId, event.documentId, embeddings.model],
        );
        const progress = Math.min(
          95,
          60 + Math.floor((35 * Number(indexed.rows[0]?.count)) / totalChunks),
        );
        await client.query(
          "UPDATE processing_jobs SET stage = 'embedding', progress = $2, updated_at = now() WHERE id = $1",
          [event.jobId, progress],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    await client.query("BEGIN");
    try {
      const current = await client.query<{ current_event_id: string }>(
        "SELECT current_event_id FROM processing_jobs WHERE id = $1 FOR UPDATE",
        [event.jobId],
      );
      if (current.rows[0]?.current_event_id !== event.eventId) {
        await client.query("ROLLBACK");
        return;
      }
      const indexed = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM document_embeddings e
         JOIN document_chunks c ON c.workspace_id = e.workspace_id AND c.id = e.chunk_id
         WHERE c.workspace_id = $1 AND c.document_id = $2 AND e.model = $3`,
        [event.workspaceId, event.documentId, embeddings.model],
      );
      if (Number(indexed.rows[0]?.count) !== totalChunks)
        throw new Error("Embedding checkpoint is incomplete");
      const marker = await client.query(
        "INSERT INTO processed_events (event_id, workspace_id, job_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id",
        [event.eventId, event.workspaceId, event.jobId],
      );
      if (!marker.rowCount) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "UPDATE processing_jobs SET status = 'completed', stage = 'done', progress = 100, last_error = NULL, updated_at = now(), finished_at = now() WHERE id = $1",
        [event.jobId],
      );
      await client.query(
        "UPDATE documents SET status = 'completed', updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [event.documentId, event.workspaceId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (locked)
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
        [event.workspaceId],
      );
    client.release();
  }
}

export async function recordFailure(
  pool: Pool,
  event: DocumentEvent,
  attempt: number,
  maxAttempts: number,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error
      ? error.message.slice(0, 500)
      : "Unknown processing error";
  const final = attempt >= maxAttempts;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      current_event_id: string;
      status: string;
    }>(
      "SELECT current_event_id, status FROM processing_jobs WHERE id = $1 FOR UPDATE",
      [event.jobId],
    );
    if (
      result.rows[0]?.current_event_id !== event.eventId ||
      result.rows[0]?.status === "completed"
    ) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      "UPDATE processing_jobs SET status = $3, stage = $4, progress = 0, attempts_made = $5, last_error = $6, updated_at = now(), finished_at = CASE WHEN $7 THEN now() ELSE NULL END WHERE id = $1 AND current_event_id = $2",
      [
        event.jobId,
        event.eventId,
        final ? "failed" : "queued",
        final ? "dead_letter" : "retrying",
        attempt,
        message,
        final,
      ],
    );
    await client.query(
      "UPDATE documents SET status = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2",
      [event.documentId, event.workspaceId, final ? "failed" : "queued"],
    );
    if (final) {
      await client.query(
        "INSERT INTO dead_letter_jobs (job_id, workspace_id, event_id, reason) VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO UPDATE SET event_id = EXCLUDED.event_id, reason = EXCLUDED.reason, failed_at = now(), retried_at = NULL",
        [event.jobId, event.workspaceId, event.eventId, message],
      );
    }
    await client.query("COMMIT");
  } catch (failure) {
    await client.query("ROLLBACK");
    throw failure;
  } finally {
    client.release();
  }
}
