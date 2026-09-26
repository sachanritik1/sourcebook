import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Router } from "express";
import multer from "multer";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth/sessions";
import { HttpError } from "../http/errors";
import { configuredMaxAttempts } from "../processing/types";
import {
  configuredPendingJobLimit,
  requireWorkspaceCapacity,
} from "../processing/admission";

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

export function documentRoutes(pool: Pool): Router {
  const router = Router();
  const pendingLimit = configuredPendingJobLimit();
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
        await requireWorkspaceCapacity(client, workspaceId, pendingLimit);
        const documentId = randomUUID();
        const jobId = randomUUID();
        const eventId = randomUUID();
        await client.query(
          "INSERT INTO documents (id, workspace_id, filename, media_type, content, status) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            documentId,
            workspaceId,
            filename,
            mediaType,
            file!.buffer,
            "queued",
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
      `SELECT d.id, d.filename, d.media_type AS "mediaType", d.status, d.created_at AS "createdAt"
       FROM documents d JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
       WHERE d.workspace_id = $1 AND m.user_id = $2 ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
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
        const document = await client.query<{ status: string }>(
          `SELECT d.status FROM documents d
         JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
         WHERE d.workspace_id = $1 AND d.id = $2 AND m.user_id = $3 FOR UPDATE OF d`,
          [workspaceId, documentId, res.locals.userId],
        );
        if (!document.rows[0])
          throw new HttpError(404, "document_not_found", "Document not found");
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

  router.get("/:workspaceId/documents/:documentId", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const documentId = z.uuid().parse(req.params.documentId);
    const result = await pool.query(
      `SELECT d.id, d.filename, d.media_type AS "mediaType", d.status, d.created_at AS "createdAt"
       FROM documents d JOIN workspace_memberships m ON m.workspace_id = d.workspace_id
       WHERE d.workspace_id = $1 AND d.id = $2 AND m.user_id = $3`,
      [workspaceId, documentId, res.locals.userId],
    );
    if (!result.rows[0])
      throw new HttpError(404, "document_not_found", "Document not found");
    res.json(result.rows[0]);
  });

  return router;
}
