import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res,
  _next,
) => {
  void _next;
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "validation_error",
      details: error.issues,
      requestId: req.id,
    });
    return;
  }
  if (error instanceof HttpError) {
    res
      .status(error.status)
      .json({ error: error.code, message: error.message, requestId: req.id });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "invalid_json", requestId: req.id });
    return;
  }
  if (
    error instanceof Error &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    res.status(413).json({ error: "body_too_large", requestId: req.id });
    return;
  }
  req.log.error({ err: error, requestId: req.id }, "request failed");
  res.status(500).json({ error: "internal_error", requestId: req.id });
};
