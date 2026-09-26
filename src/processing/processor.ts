import type { Pool, PoolClient } from "pg";
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

    await setProgress(client, event, "extracting", 20, attempt);
    const text = await extractText(document.content, document.media_type);
    await setProgress(client, event, "chunking", 60, attempt);
    const chunks = chunkText(text);

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
      const marker = await client.query(
        "INSERT INTO processed_events (event_id, workspace_id, job_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id",
        [event.eventId, event.workspaceId, event.jobId],
      );
      if (!marker.rowCount) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "DELETE FROM document_chunks WHERE workspace_id = $1 AND document_id = $2",
        [event.workspaceId, event.documentId],
      );
      for (const [ordinal, content] of chunks.entries()) {
        await client.query(
          "INSERT INTO document_chunks (workspace_id, document_id, ordinal, content) VALUES ($1, $2, $3, $4)",
          [event.workspaceId, event.documentId, ordinal, content],
        );
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
