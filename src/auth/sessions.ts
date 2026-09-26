import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RequestHandler } from "express";
import { HttpError } from "../http/errors";

type Database = Pool | PoolClient;
const SESSION_DAYS = 7;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

export function requireUser(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
        req.header("authorization") ?? "",
      );
      if (!match?.[1])
        throw new HttpError(
          401,
          "unauthorized",
          "A valid bearer token is required",
        );
      const result = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
        [hashToken(match[1])],
      );
      if (!result.rows[0])
        throw new HttpError(401, "unauthorized", "Session expired or invalid");
      res.locals.userId = result.rows[0].user_id;
      res.locals.sessionHash = hashToken(match[1]);
      next();
    } catch (error) {
      next(error);
    }
  };
}
