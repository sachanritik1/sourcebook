import express from "express";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { authRoutes } from "./auth/routes";
import { workspaceRoutes } from "./workspaces/routes";
import { errorHandler } from "./http/errors";
import { documentRoutes } from "./documents/routes";
import { jobRoutes, workspaceJobRoutes } from "./jobs/routes";

export function createApp(pool: Pool) {
  const app = express();
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      wrapSerializers: false,
      serializers: {
        // Keep credentials and future signed URLs out of structured request logs.
        req: (req) => ({
          id: req.id,
          method: req.method,
          path: req.url?.split("?", 1)[0],
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      genReqId: (req) => {
        const incoming = req.headers["x-request-id"];
        return typeof incoming === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(incoming)
          ? incoming
          : randomUUID();
      },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader("x-request-id", String(req.id));
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  app.use("/auth", authRoutes(pool));
  app.use("/workspaces", workspaceRoutes(pool));
  app.use("/workspaces", documentRoutes(pool));
  app.use("/workspaces", workspaceJobRoutes(pool));
  app.use("/jobs", jobRoutes(pool));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler);
  return app;
}
