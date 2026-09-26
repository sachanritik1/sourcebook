import type { RequestHandler } from "express";
import { HttpError } from "../http/errors";
import type { RateCounter } from "./fixed-window";

export function configuredRateLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 10_000)
    throw new Error(`${name} must be an integer from 1 to 10000`);
  return value;
}

export function configuredTrustProxyHops(): number {
  const value = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(value) || value < 0 || value > 3)
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 3");
  return value;
}

export function ipRateLimit(
  counter: RateCounter,
  code: string,
  unavailable: "allow" | "reject",
): RequestHandler {
  return async (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    try {
      if (!(await counter.take(ip))) {
        res.setHeader(
          "Retry-After",
          String(Math.ceil((60_000 - (Date.now() % 60_000)) / 1000)),
        );
        throw new HttpError(429, code, "Request limit reached; retry shortly");
      }
      next();
    } catch (error) {
      if (error instanceof HttpError) {
        next(error);
        return;
      }
      req.log.warn(
        { err: error, requestId: req.id },
        "rate limit backend unavailable",
      );
      if (unavailable === "allow") next();
      else
        next(
          new HttpError(
            503,
            "rate_limit_unavailable",
            "Authentication temporarily unavailable",
          ),
        );
    }
  };
}
