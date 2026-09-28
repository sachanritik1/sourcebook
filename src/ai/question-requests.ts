import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { HttpError } from "../http/errors";

type QuestionRequest = {
  user_id: string;
  request_fingerprint: string;
  status: "in_progress" | "completed" | "uncertain";
  response_body: unknown;
  created_at: Date;
};

export function questionFingerprint(question: string, topK: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ question, topK }))
    .digest("hex");
}

export async function reserveQuestion(
  pool: Pool,
  workspaceId: string,
  userId: string,
  key: string,
  fingerprint: string,
): Promise<{ fresh: true } | { fresh: false; response: unknown }> {
  const inserted = await pool.query(
    `INSERT INTO question_requests
     (workspace_id, idempotency_key, user_id, request_fingerprint, status)
     VALUES ($1, $2, $3, $4, 'in_progress')
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [workspaceId, key, userId, fingerprint],
  );
  if (inserted.rowCount) return { fresh: true };
  const existing = await pool.query<QuestionRequest>(
    `SELECT user_id, request_fingerprint, status, response_body, created_at
     FROM question_requests WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, key],
  );
  const previous = existing.rows[0];
  if (!previous) throw new Error("Question reservation disappeared");
  if (
    previous.user_id !== userId ||
    previous.request_fingerprint !== fingerprint
  )
    throw new HttpError(
      409,
      "idempotency_key_reused",
      "Idempotency-Key was used for a different question",
    );
  if (previous.status === "completed")
    return { fresh: false, response: previous.response_body };
  if (
    previous.status === "uncertain" ||
    Date.now() - previous.created_at.getTime() > 120_000
  )
    throw new HttpError(
      409,
      "question_outcome_unknown",
      "The provider outcome is unknown; check usage before starting a new question",
    );
  throw new HttpError(
    409,
    "question_in_progress",
    "This question is still processing; retry with the same key shortly",
  );
}

export async function forgetQuestion(
  pool: Pool,
  workspaceId: string,
  key: string,
): Promise<void> {
  await pool.query(
    "DELETE FROM question_requests WHERE workspace_id = $1 AND idempotency_key = $2 AND status = 'in_progress'",
    [workspaceId, key],
  );
}

export async function markQuestionUncertain(
  pool: Pool,
  workspaceId: string,
  key: string,
): Promise<void> {
  await pool.query(
    "UPDATE question_requests SET status = 'uncertain' WHERE workspace_id = $1 AND idempotency_key = $2 AND status = 'in_progress'",
    [workspaceId, key],
  );
}

export async function completeQuestion(
  client: PoolClient,
  workspaceId: string,
  key: string,
  response: unknown,
): Promise<void> {
  const saved = await client.query(
    `UPDATE question_requests
     SET status = 'completed', response_body = $3, completed_at = now()
     WHERE workspace_id = $1 AND idempotency_key = $2 AND status IN ('in_progress', 'uncertain')`,
    [workspaceId, key, JSON.stringify(response)],
  );
  if (saved.rowCount !== 1) throw new Error("Question reservation lost");
}
