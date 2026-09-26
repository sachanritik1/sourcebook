import type { PoolClient } from "pg";
import { HttpError } from "../http/errors";

export function configuredPendingJobLimit(): number {
  const limit = Number(process.env.MAX_PENDING_JOBS_PER_WORKSPACE ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error(
      "MAX_PENDING_JOBS_PER_WORKSPACE must be an integer from 1 to 100",
    );
  return limit;
}

// Call inside the transaction that creates or requeues a job. All admission
// paths use the same workspace lock, so concurrent count-and-insert decisions
// cannot both consume the last slot. Seed 1 keeps this distinct from the
// worker's session advisory lock (seed 0).
export async function requireWorkspaceCapacity(
  client: PoolClient,
  workspaceId: string,
  limit: number,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))",
    [workspaceId],
  );
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM processing_jobs
     WHERE workspace_id = $1 AND status IN ('queued', 'processing')`,
    [workspaceId],
  );
  if ((active.rows[0]?.count ?? 0) >= limit)
    throw new HttpError(
      429,
      "workspace_job_limit",
      "Workspace has too many queued or processing jobs; retry after a job finishes",
    );
}
