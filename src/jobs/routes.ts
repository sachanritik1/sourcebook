import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth/sessions";
import { HttpError } from "../http/errors";
import {
  configuredPendingJobLimit,
  requireWorkspaceCapacity,
} from "../processing/admission";

const jobSelect = `SELECT j.id, j.document_id AS "documentId", j.workspace_id AS "workspaceId",
  j.status, j.stage, j.progress, j.attempts_made AS "attemptsMade",
  j.max_attempts AS "maxAttempts", j.last_error AS "lastError",
  j.created_at AS "createdAt", j.updated_at AS "updatedAt", j.finished_at AS "finishedAt"
  FROM processing_jobs j
  JOIN documents d ON d.workspace_id = j.workspace_id AND d.id = j.document_id
    AND d.status NOT IN ('deleting', 'deleted')
    AND (d.expires_at IS NULL OR d.expires_at > now())
  JOIN workspace_memberships m ON m.workspace_id = j.workspace_id`;

export function jobRoutes(pool: Pool): Router {
  const router = Router();
  const pendingLimit = configuredPendingJobLimit();
  router.use(requireUser(pool));

  router.get("/:jobId", async (req, res) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const result = await pool.query(
      `${jobSelect} WHERE j.id = $1 AND m.user_id = $2`,
      [jobId, res.locals.userId],
    );
    if (!result.rows[0])
      throw new HttpError(404, "job_not_found", "Job not found");
    res.json(result.rows[0]);
  });

  router.post("/:jobId/retry", async (req, res) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        workspace_id: string;
        document_id: string;
        document_status: string;
        expired: boolean;
      }>(
        `SELECT j.workspace_id, j.document_id, d.status AS document_status,
                (d.expires_at IS NOT NULL AND d.expires_at <= now()) AS expired
         FROM processing_jobs j
         JOIN documents d ON d.workspace_id = j.workspace_id AND d.id = j.document_id
         JOIN workspace_memberships m ON m.workspace_id = j.workspace_id
         WHERE j.id = $1 AND m.user_id = $2 FOR UPDATE OF d`,
        [jobId, res.locals.userId],
      );
      const job = result.rows[0];
      if (!job) throw new HttpError(404, "job_not_found", "Job not found");
      if (["deleting", "deleted"].includes(job.document_status) || job.expired)
        throw new HttpError(
          410,
          "document_deleted",
          "Document is no longer available",
        );
      const locked = await client.query<{ status: string }>(
        "SELECT status FROM processing_jobs WHERE id = $1 FOR UPDATE",
        [jobId],
      );
      if (locked.rows[0]?.status !== "failed")
        throw new HttpError(
          409,
          "job_not_failed",
          "Only failed jobs can be retried",
        );
      await requireWorkspaceCapacity(client, job.workspace_id, pendingLimit);
      const eventId = randomUUID();
      await client.query(
        `UPDATE processing_jobs SET current_event_id = $2, status = 'queued', stage = 'waiting_for_publisher',
          progress = 0, attempts_made = 0, last_error = NULL, updated_at = now(), finished_at = NULL WHERE id = $1`,
        [jobId, eventId],
      );
      await client.query(
        "UPDATE documents SET status = 'queued', updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [job.document_id, job.workspace_id],
      );
      await client.query(
        "UPDATE dead_letter_jobs SET retried_at = now() WHERE job_id = $1",
        [jobId],
      );
      await client.query(
        "INSERT INTO outbox_events (id, workspace_id, job_id, event_type, payload) VALUES ($1, $2, $3, $4, $5)",
        [
          eventId,
          job.workspace_id,
          jobId,
          "document.process",
          JSON.stringify({
            eventId,
            workspaceId: job.workspace_id,
            documentId: job.document_id,
            jobId,
            requestId: req.id,
          }),
        ],
      );
      await client.query("COMMIT");
      res.status(202).json({ jobId, status: "queued" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  return router;
}

export function workspaceJobRoutes(pool: Pool): Router {
  const router = Router();
  router.use(requireUser(pool));
  router.get("/:workspaceId/jobs", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const status = z
      .enum(["queued", "processing", "completed", "failed"])
      .optional()
      .parse(req.query.status);
    const membership = await pool.query(
      "SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, res.locals.userId],
    );
    if (!membership.rowCount)
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    const result = await pool.query(
      `${jobSelect} WHERE j.workspace_id = $1 AND m.user_id = $2 AND ($3::text IS NULL OR j.status = $3)
       ORDER BY j.created_at DESC LIMIT 100`,
      [workspaceId, res.locals.userId, status ?? null],
    );
    res.json({ jobs: result.rows });
  });
  return router;
}
