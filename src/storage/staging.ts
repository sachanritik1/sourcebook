import type { Pool, PoolClient } from "pg";
import { HttpError } from "../http/errors";
import {
  acquireWorkspaceAdmission,
  requireWorkspaceCapacity,
} from "../processing/admission";
import { stagedObjectKey, type ObjectStore } from "./objects";

type StagedUpload = {
  request_fingerprint: string;
  object_key: string;
  status: "pending" | "deleting";
};

export async function reserveStagedUpload(
  pool: Pool,
  workspaceId: string,
  userId: string,
  idempotencyKey: string,
  fingerprint: string,
  pendingLimit: number,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const member = await client.query(
      "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE",
      [workspaceId, userId],
    );
    if (!member.rowCount)
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    await acquireWorkspaceAdmission(client, workspaceId);
    const previous = await client.query<StagedUpload>(
      `SELECT request_fingerprint, object_key, status FROM upload_staging
       WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    if (previous.rows[0]) {
      const row = previous.rows[0];
      if (row.request_fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "idempotency_key_reused",
          "Idempotency-Key was used for a different upload",
        );
      if (row.status !== "pending")
        throw new HttpError(
          409,
          "upload_expired",
          "Staged upload expired; start a new upload",
        );
      await client.query("COMMIT");
      return row.object_key;
    }
    await requireWorkspaceCapacity(client, workspaceId, pendingLimit);
    const pending = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM upload_staging s
       WHERE s.workspace_id = $1 AND s.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM upload_idempotency i
           WHERE i.workspace_id = s.workspace_id AND i.idempotency_key = s.idempotency_key
         )`,
      [workspaceId],
    );
    if (Number(pending.rows[0]?.count) >= pendingLimit)
      throw new HttpError(
        429,
        "workspace_job_limit",
        "Workspace has too many pending uploads",
      );
    const objectKey = stagedObjectKey(workspaceId, idempotencyKey);
    await client.query(
      `INSERT INTO upload_staging
       (workspace_id, idempotency_key, request_fingerprint, object_key)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, idempotencyKey, fingerprint, objectKey],
    );
    await client.query("COMMIT");
    return objectKey;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockedStagedUpload(
  client: PoolClient,
  workspaceId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<string> {
  const result = await client.query<StagedUpload>(
    `SELECT request_fingerprint, object_key, status FROM upload_staging
     WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE`,
    [workspaceId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row || row.status !== "pending")
    throw new HttpError(
      409,
      "upload_expired",
      "Staged upload expired; start a new upload",
    );
  if (row.request_fingerprint !== fingerprint)
    throw new HttpError(
      409,
      "idempotency_key_reused",
      "Idempotency-Key was used for a different upload",
    );
  return row.object_key;
}

export async function cleanupStagedUploads(
  pool: Pool,
  objects: ObjectStore,
  limit = 20,
): Promise<number> {
  let cleaned = 0;
  for (let index = 0; index < limit; index++) {
    const client = await pool.connect();
    let objectKey: string | undefined;
    let shouldDeleteObject = false;
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        workspace_id: string;
        idempotency_key: string;
        object_key: string;
        finalized: boolean;
      }>(
        `SELECT s.workspace_id, s.idempotency_key, s.object_key,
                EXISTS (SELECT 1 FROM upload_idempotency i
                        WHERE i.workspace_id = s.workspace_id AND i.idempotency_key = s.idempotency_key) AS finalized
         FROM upload_staging s
         WHERE s.created_at < now() - interval '24 hours'
         ORDER BY s.created_at, s.idempotency_key
         FOR UPDATE OF s SKIP LOCKED LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        break;
      }
      objectKey = row.object_key;
      if (row.finalized) {
        await client.query(
          "DELETE FROM upload_staging WHERE workspace_id = $1 AND idempotency_key = $2",
          [row.workspace_id, row.idempotency_key],
        );
      } else {
        await client.query(
          "UPDATE upload_staging SET status = 'deleting' WHERE workspace_id = $1 AND idempotency_key = $2",
          [row.workspace_id, row.idempotency_key],
        );
        shouldDeleteObject = true;
      }
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (shouldDeleteObject && objectKey) {
      await objects.delete(objectKey);
      await pool.query(
        "DELETE FROM upload_staging WHERE object_key = $1 AND status = 'deleting'",
        [objectKey],
      );
    }
    cleaned++;
  }
  return cleaned;
}
