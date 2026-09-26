import { Router } from "express";
import type { Pool } from "pg";
import * as argon2 from "argon2";
import { z } from "zod";
import { HttpError } from "../http/errors";
import { createSession, requireUser } from "./sessions";

const credentials = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: z.string().min(12).max(128),
  })
  .strict();

export function authRoutes(pool: Pool): Router {
  const router = Router();

  router.post("/register", async (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash],
      );
      const userId = result.rows[0]!.id;
      const session = await createSession(client, userId);
      await client.query("COMMIT");
      res.status(201).json({ userId, email, ...session });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && "code" in error && error.code === "23505") {
        throw new HttpError(409, "email_taken", "Email is already registered");
      }
      throw error;
    } finally {
      client.release();
    }
  });

  router.post("/login", async (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const result = await pool.query<{ id: string; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email],
    );
    const user = result.rows[0];
    if (!user || !(await argon2.verify(user.password_hash, password))) {
      throw new HttpError(
        401,
        "invalid_credentials",
        "Invalid email or password",
      );
    }
    const session = await createSession(pool, user.id);
    res.json({ userId: user.id, email, ...session });
  });

  router.post("/logout", requireUser(pool), async (req, res) => {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
      res.locals.sessionHash,
    ]);
    res.sendStatus(204);
  });

  return router;
}
