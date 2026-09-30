import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ObjectStore } from "../storage/objects";

type DeletableDocument = {
  id: string;
  workspace_id: string;
  storage_key: string | null;
};

export function configuredDocumentRetentionDays(): number {
  const value = Number(process.env.DOCUMENT_RETENTION_DAYS ?? "0");
  if (!Number.isInteger(value) || value < 0 || value > 3650)
    throw new Error(
      "DOCUMENT_RETENTION_DAYS must be an integer from 0 to 3650",
    );
  return value;
}

export async function requestDocumentDeletion(
  client: PoolClient,
  document: DeletableDocument,
): Promise<void> {
  await client.query(
    "UPDATE documents SET status = 'deleting', updated_at = now() WHERE workspace_id = $1 AND id = $2",
    [document.workspace_id, document.id],
  );
  await client.query(
    `UPDATE upload_staging s SET status = 'deleting'
     FROM upload_idempotency i
     WHERE i.workspace_id = $1 AND i.document_id = $2
       AND s.workspace_id = i.workspace_id AND s.idempotency_key = i.idempotency_key`,
    [document.workspace_id, document.id],
  );
  await client.query(
    `UPDATE question_requests
     SET status = 'invalidated', response_body = NULL, completed_at = NULL
     WHERE workspace_id = $1 AND response_body->'citations' @> $2::jsonb`,
    [document.workspace_id, JSON.stringify([{ documentId: document.id }])],
  );
  await client.query(
    "DELETE FROM document_chunks WHERE workspace_id = $1 AND document_id = $2",
    [document.workspace_id, document.id],
  );
  await client.query(
    `INSERT INTO document_deletions (workspace_id, document_id, object_key, available_at)
     VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN now() ELSE now() + interval '2 minutes' END)
     ON CONFLICT (workspace_id, document_id) DO NOTHING`,
    [document.workspace_id, document.id, document.storage_key],
  );
}

export async function expireDocuments(pool: Pool, limit = 20): Promise<number> {
  let expired = 0;
  for (let index = 0; index < limit; index++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DeletableDocument>(
        `SELECT id, workspace_id, storage_key FROM documents
         WHERE expires_at <= now() AND status IN ('completed', 'failed')
         ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const document = result.rows[0];
      if (!document) {
        await client.query("COMMIT");
        break;
      }
      await requestDocumentDeletion(client, document);
      await client.query("COMMIT");
      expired++;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return expired;
}

type ClaimedDeletion = {
  workspace_id: string;
  document_id: string;
  object_key: string | null;
  attempts: number;
};

export async function processDocumentDeletions(
  pool: Pool,
  objects?: ObjectStore,
  limit = 20,
): Promise<{ completed: number; failed: number }> {
  const claimToken = randomUUID();
  const claimed = await pool.query<ClaimedDeletion>(
    `WITH due AS (
       SELECT workspace_id, document_id FROM document_deletions
       WHERE available_at <= now() AND (locked_until IS NULL OR locked_until < now())
       ORDER BY available_at, document_id FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE document_deletions d
     SET claim_token = $2, locked_until = now() + interval '45 seconds', attempts = attempts + 1
     FROM due WHERE d.workspace_id = due.workspace_id AND d.document_id = due.document_id
     RETURNING d.workspace_id, d.document_id, d.object_key, d.attempts`,
    [limit, claimToken],
  );
  let completed = 0;
  let failed = 0;
  for (const row of claimed.rows) {
    try {
      if (row.object_key) {
        if (!objects)
          throw new Error("Private object storage is not configured");
        await objects.delete(row.object_key);
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `SELECT 1 FROM document_deletions
           WHERE workspace_id = $1 AND document_id = $2 AND claim_token = $3 FOR UPDATE`,
          [row.workspace_id, row.document_id, claimToken],
        );
        if (current.rowCount) {
          const redacted = await client.query(
            `UPDATE documents SET status = 'deleted', filename = '[deleted]',
               content = NULL, storage_key = NULL, content_sha256 = NULL,
               deleted_at = now(), updated_at = now()
             WHERE workspace_id = $1 AND id = $2 AND status = 'deleting'`,
            [row.workspace_id, row.document_id],
          );
          if (redacted.rowCount !== 1)
            throw new Error("Document deletion state changed");
          await client.query(
            "DELETE FROM document_chunks WHERE workspace_id = $1 AND document_id = $2",
            [row.workspace_id, row.document_id],
          );
          await client.query(
            `UPDATE question_requests
             SET status = 'invalidated', response_body = NULL, completed_at = NULL
             WHERE workspace_id = $1 AND response_body->'citations' @> $2::jsonb`,
            [
              row.workspace_id,
              JSON.stringify([{ documentId: row.document_id }]),
            ],
          );
          await client.query(
            "DELETE FROM document_deletions WHERE workspace_id = $1 AND document_id = $2 AND claim_token = $3",
            [row.workspace_id, row.document_id, claimToken],
          );
        }
        await client.query("COMMIT");
        if (current.rowCount) completed++;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const delaySeconds = Math.min(
        3600,
        30 * 2 ** Math.min(row.attempts - 1, 7),
      );
      await pool.query(
        `UPDATE document_deletions
         SET claim_token = NULL, locked_until = NULL,
             available_at = now() + $4::int * interval '1 second', last_error = $5
         WHERE workspace_id = $1 AND document_id = $2 AND claim_token = $3`,
        [
          row.workspace_id,
          row.document_id,
          claimToken,
          delaySeconds,
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown deletion error",
        ],
      );
      failed++;
    }
  }
  return { completed, failed };
}
