import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, unsealSession } from "./session";

export function validOrigin(request: Request): boolean {
  const expected = process.env.WEB_PUBLIC_ORIGIN;
  return Boolean(expected && request.headers.get("origin") === expected);
}

export function forbidden(): NextResponse {
  return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
}

export function currentSession(request: NextRequest) {
  return unsealSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 4096) {
    throw new Error("request_too_large");
  }
  const body = await request.text();
  if (body.length > 4096) throw new Error("request_too_large");
  return JSON.parse(body);
}

export async function backend(
  path: string,
  options: {
    method: "GET" | "POST";
    token?: string;
    body?: unknown;
    form?: FormData;
    idempotencyKey?: string;
  },
): Promise<NextResponse> {
  const base = process.env.API_BASE_URL;
  if (!base) throw new Error("API_BASE_URL is required");
  const requestId = randomUUID();
  try {
    const response = await fetch(new URL(path, base), {
      method: options.method,
      headers: {
        "X-Request-ID": requestId,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body:
        options.form ??
        (options.body ? JSON.stringify(options.body) : undefined),
      cache: "no-store",
      signal: AbortSignal.timeout(options.form ? 30_000 : 10_000),
    });
    if (response.status === 204) {
      return new NextResponse(null, {
        status: 204,
        headers: { "X-Request-ID": requestId },
      });
    }
    const payload: unknown = await response
      .json()
      .catch(() => ({ error: "upstream_error" }));
    const result = NextResponse.json(payload, { status: response.status });
    result.headers.set(
      "X-Request-ID",
      response.headers.get("x-request-id") ?? requestId,
    );
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) result.headers.set("Retry-After", retryAfter);
    return result;
  } catch {
    return NextResponse.json(
      { error: "api_unavailable" },
      { status: 503, headers: { "X-Request-ID": requestId } },
    );
  }
}
