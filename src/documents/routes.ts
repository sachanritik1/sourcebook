import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Router } from "express";
import multer from "multer";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { requireUser } from "../auth/sessions";
import { HttpError } from "../http/errors";
import { configuredMaxAttempts } from "../processing/types";
import {
  acquireWorkspaceAdmission,
  configuredPendingJobLimit,
  requireWorkspaceCapacity,
} from "../processing/admission";
import type { ObjectStore } from "../storage/objects";
import { lockedStagedUpload, reserveStagedUpload } from "../storage/staging";
import {
  configuredDocumentRetentionDays,
  requestDocumentDeletion,
} from "./deletion";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

function validatedFile(file: Express.Multer.File | undefined): {
  filename: string;
  mediaType: "application/pdf" | "text/plain";
} {
  if (!file || file.size === 0)
    throw new HttpError(
      400,
      "file_required",
      "A nonempty file field is required",
    );
  const filename = basename(file.originalname).replaceAll("\0", "").trim();
  if (!filename || filename.length > 255)
    throw new HttpError(
      400,
      "invalid_filename",
      "Filename must be 1 to 255 characters",
    );
  if (
    file.mimetype === "application/pdf" &&
    file.buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return { filename, mediaType: "application/pdf" };
  }
  if (file.mimetype === "text/plain") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
      return { filename, mediaType: "text/plain" };
    } catch {
      throw new HttpError(400, "invalid_text", "Text file must be UTF-8");
    }
  }
  throw new HttpError(
    400,
    "unsupported_file",
    "Only UTF-8 text and PDF files are accepted",
  );
}

function validatedIdempotencyKey(value: string | undefined): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be a UUID",
    );
  return parsed.data;
}

function uploadFingerprint(
  filename: string,
  mediaType: string,
  content: Buffer,
): string {
  return createHash("sha256")
    .update(filename)
    .update("\0")
    .update(mediaType)
    .update("\0")
    .update(content)
    .digest("hex");
}

type PreviousUpload = {
  request_fingerprint: string;
  document_id: string;
  job_id: string;
  status: string;
  document_status: string;
  expired: boolean;
};

async function previousUpload(
  db: Pool | PoolClient,
  workspaceId: string,
  key: string,
): Promise<PreviousUpload | undefined> {
  const result = await db.query<PreviousUpload>(
    `SELECT i.request_fingerprint, i.document_id, i.job_id, j.status,
            d.status AS document_status,
            (d.expires_at IS NOT NULL AND d.expires_at <= now()) AS expired
     FROM upload_idempotency i
     JOIN processing_jobs j ON j.workspace_id = i.workspace_id AND j.id = i.job_id
     JOIN documents d ON d.workspace_id = i.workspace_id AND d.id = i.document_id
     WHERE i.workspace_id = $1 AND i.idempotency_key = $2`,
    [workspaceId, key],
  );
  return result.rows[0];
}

function assertReplayAvailable(row: PreviousUpload, fingerprint: string): void {
  if (row.request_fingerprint !== fingerprint)
    throw new HttpError(
      409,
      "idempotency_key_reused",
      "Idempotency-Key was used for a different upload",
    );
  if (["deleting", "deleted"].includes(row.document_status) || row.expired)
    throw new HttpError(
      410,
      "document_deleted",
      "Document is no longer available",
    );
}

export function documentRoutes(pool: Pool, objects?: ObjectStore): Router {
  const router = Router();
  const pendingLimit = configuredPendingJobLimit();
  const retentionDays = configuredDocumentRetentionDays();
  router.use(requireUser(pool));

  router.post(
    "/:workspaceId/documents",
    async (req, res, next) => {
      try {
        const workspaceId = z.uuid().parse(req.params.workspaceId);
        const membership = await pool.query(
          "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, res.locals.userId],
        );
        if (!membership.rowCount)
          throw new HttpError(
            404,
            "workspace_not_found",
            "Workspace not found",
          );
        validatedIdempotencyKey(req.get("Idempotency-Key"));
        next();
      } catch (error) {
        next(error);
      }
    },
    upload.single("file"),
    async (req, res) => {
      const workspaceId = z.uuid().parse(req.params.workspaceId);
      const file = req.file;
      const { filename, mediaType } = validatedFile(file);
      const idempotencyKey = validatedIdempotencyKey(
        req.get("Idempotency-Key"),
      );
      const fingerprint = uploadFingerprint(filename, mediaType, file!.buffer);
      if (objects) {
        const previous = await previousUpload(
          pool,
          workspaceId,
          idempotencyKey,
        );
        if (previous) {
          assertReplayAvailable(previous, fingerprint);
          res.status(200).json({
            documentId: previous.document_id,
            jobId: previous.job_id,
            status: previous.status,
          });
          return;
        }
      }
      const storageKey = objects
        ? await reserveStagedUpload(
            pool,
            workspaceId,
            res.locals.userId,
            idempotencyKey,
            fingerprint,
            pendingLimit,
          )
        : undefined;
      if (objects && storageKey) {
        try {
          await objects.put(storageKey, file!.buffer, mediaType);
        } catch (error) {
          req.log.error(
            { err: error, workspaceId, uploadKey: idempotencyKey },
            "object upload failed",
          );
          throw new HttpError(
            503,
            "object_storage_unavailable",
            "Private file storage unavailable; retry with the same key",
          );
        }
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const membership = await client.query(
          "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE",
          [workspaceId, res.locals.userId],
        );
        if (!membership.rowCount)
          throw new HttpError(
            404,
            "workspace_not_found",
            "Workspace not found",
          );
        await acquireWorkspaceAdmission(client, workspaceId);
        const previous = await previousUpload(
          client,
          workspaceId,
          idempotencyKey,
        );
        if (previous) {
          assertReplayAvailable(previous, fingerprint);
          await client.query("COMMIT");
          res.status(200).json({
            documentId: previous.document_id,
            jobId: previous.job_id,
            status: previous.status,
          });
          return;
        }
        if (storageKey)
          await lockedStagedUpload(
            client,
            workspaceId,
            idempotencyKey,
            fingerprint,
          );
        await requireWorkspaceCapacity(client, workspaceId, pendingLimit);
        const documentId = randomUUID();
        const jobId = randomUUID();
        const eventId = randomUUID();
        await client.query(
          `INSERT INTO documents
           (id, workspace_id, filename, media_type, content, storage_key, content_sha256, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued',
             CASE WHEN $8::int = 0 THEN NULL ELSE now() + $8::int * interval '1 day' END)`,
          [
            documentId,
            workspaceId,
            filename,
            mediaType,
            storageKey ? null : file!.buffer,
            storageKey ?? null,
            storageKey
              ? createHash("sha256").update(file!.buffer).digest("hex")
              : null,
            retentionDays,
          ],
        );
        await client.query(
          "INSERT INTO processing_jobs (id, workspace_id, document_id, current_event_id, status, stage, progress, max_attempts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            jobId,
            workspaceId,
            documentId,
            eventId,
            "queued",
            "waiting_for_publisher",
            0,
            configuredMaxAttempts(),
          ],
        );
        await client.query(
          "INSERT INTO outbox_events (id, workspace_id, job_id, event_type, payload) VALUES ($1, $2, $3, $4, $5)",
          [
            eventId,
            workspaceId,
            jobId,
            "document.process",
            JSON.stringify({
              eventId,
              workspaceId,
              documentId,
              jobId,
              requestId: req.id,
            }),
          ],
        );
        await client.query(
          `INSERT INTO upload_idempotency
           (workspace_id, idempotency_key, request_fingerprint, document_id, job_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, idempotencyKey, fingerprint, documentId, jobId],
        );
        await client.query("COMMIT");
        res.status(202).json({ documentId, jobId, status: "queued" });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  router.get("/:workspaceId/documents", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const membership = await pool.query(
      "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, res.locals.userId],
    );
    if (!membership.rowCount)
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    const result = await pool.query(
      `SELECT d.id, d.filename, d.media_type AS "mediaType", d.status,
              d.created_at AS "createdAt", d.expires_at AS "expiresAt"
       FROM documents d JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
       WHERE d.workspace_id = $1 AND m.user_id = $2
         AND d.status NOT IN ('deleting', 'deleted')
         AND (d.expires_at IS NULL OR d.expires_at > now())
       ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
      [workspaceId, res.locals.userId],
    );
    res.json({ documents: result.rows });
  });

  router.post(
    "/:workspaceId/documents/:documentId/reindex",
    async (req, res) => {
      const workspaceId = z.uuid().parse(req.params.workspaceId);
      const documentId = z.uuid().parse(req.params.documentId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const document = await client.query<{
          status: string;
          expired: boolean;
        }>(
          `SELECT d.status, (d.expires_at IS NOT NULL AND d.expires_at <= now()) AS expired FROM documents d
         JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
         WHERE d.workspace_id = $1 AND d.id = $2 AND m.user_id = $3 FOR UPDATE OF d`,
          [workspaceId, documentId, res.locals.userId],
        );
        if (!document.rows[0])
          throw new HttpError(404, "document_not_found", "Document not found");
        if (document.rows[0].expired)
          throw new HttpError(410, "document_expired", "Document has expired");
        if (document.rows[0].status !== "completed")
          throw new HttpError(
            409,
            "document_not_completed",
            "Only completed documents can be reindexed",
          );
        await requireWorkspaceCapacity(client, workspaceId, pendingLimit);
        const jobId = randomUUID();
        const eventId = randomUUID();
        await client.query(
          "UPDATE documents SET status = 'queued', updated_at = now() WHERE workspace_id = $1 AND id = $2",
          [workspaceId, documentId],
        );
        await client.query(
          `INSERT INTO processing_jobs (id, workspace_id, document_id, current_event_id, status, stage, progress, max_attempts)
         VALUES ($1, $2, $3, $4, 'queued', 'waiting_for_publisher', 0, $5)`,
          [jobId, workspaceId, documentId, eventId, configuredMaxAttempts()],
        );
        await client.query(
          "INSERT INTO outbox_events (id, workspace_id, job_id, event_type, payload) VALUES ($1, $2, $3, 'document.process', $4)",
          [
            eventId,
            workspaceId,
            jobId,
            JSON.stringify({
              eventId,
              workspaceId,
              documentId,
              jobId,
              requestId: req.id,
            }),
          ],
        );
        await client.query("COMMIT");
        res.status(202).json({ documentId, jobId, status: "queued" });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  router.delete("/:workspaceId/documents/:documentId", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const documentId = z.uuid().parse(req.params.documentId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        workspace_id: string;
        storage_key: string | null;
        status: string;
        role: string;
      }>(
        `SELECT d.id, d.workspace_id, d.storage_key, d.status, m.role
         FROM documents d JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
         WHERE d.workspace_id = $1 AND d.id = $2 AND m.user_id = $3
         FOR UPDATE OF d`,
        [workspaceId, documentId, res.locals.userId],
      );
      const document = result.rows[0];
      if (!document)
        throw new HttpError(404, "document_not_found", "Document not found");
      if (document.role !== "owner")
        throw new HttpError(
          403,
          "owner_required",
          "Only workspace owners can delete documents",
        );
      if (document.status === "deleted") {
        await client.query("COMMIT");
        res.sendStatus(204);
        return;
      }
      if (document.status !== "deleting") {
        if (document.status !== "completed" && document.status !== "failed")
          throw new HttpError(
            409,
            "document_processing",
            "Wait for processing to finish before deleting",
          );
        await requestDocumentDeletion(client, document);
      }
      await client.query("COMMIT");
      res.status(202).json({ documentId, status: "deleting" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  router.get("/:workspaceId/documents/:documentId", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const documentId = z.uuid().parse(req.params.documentId);
    const result = await pool.query(
      `SELECT d.id, d.filename, d.media_type AS "mediaType", d.status,
              d.created_at AS "createdAt", d.expires_at AS "expiresAt"
       FROM documents d JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
       WHERE d.workspace_id = $1 AND d.id = $2 AND m.user_id = $3
         AND d.status NOT IN ('deleting', 'deleted')
         AND (d.expires_at IS NULL OR d.expires_at > now())`,
      [workspaceId, documentId, res.locals.userId],
    );
    if (!result.rows[0])
      throw new HttpError(404, "document_not_found", "Document not found");
    res.json(result.rows[0]);
  });

  return router;
}
