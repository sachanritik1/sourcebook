import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { HttpError } from "../http/errors";
import { requireUser } from "../auth/sessions";

const createWorkspace = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export function workspaceRoutes(pool: Pool): Router {
  const router = Router();
  router.use(requireUser(pool));

  router.post("/", async (req, res) => {
    const { name } = createWorkspace.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; name: string }>(
        "INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name",
        [name],
      );
      const workspace = result.rows[0]!;
      await client.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [workspace.id, res.locals.userId, "owner"],
      );
      await client.query("COMMIT");
      res.status(201).json(workspace);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  router.get("/", async (_req, res) => {
    const result = await pool.query<{ id: string; name: string; role: string }>(
      "SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at, w.id",
      [res.locals.userId],
    );
    res.json({ workspaces: result.rows });
  });

  router.get("/:workspaceId", async (req, res) => {
    const workspaceId = z.uuid().parse(req.params.workspaceId);
    const result = await pool.query<{ id: string; name: string; role: string }>(
      "SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id WHERE w.id = $1 AND m.user_id = $2",
      [workspaceId, res.locals.userId],
    );
    if (!result.rows[0])
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    res.json(result.rows[0]);
  });

  return router;
}
