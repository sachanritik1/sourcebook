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
  options: { method: "GET" | "POST"; token?: string; body?: unknown },
): Promise<NextResponse> {
  const base = process.env.API_BASE_URL;
  if (!base) throw new Error("API_BASE_URL is required");
  try {
    const response = await fetch(new URL(path, base), {
      method: options.method,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 204) return new NextResponse(null, { status: 204 });
    const payload: unknown = await response
      .json()
      .catch(() => ({ error: "upstream_error" }));
    const result = NextResponse.json(payload, { status: response.status });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) result.headers.set("Retry-After", retryAfter);
    return result;
  } catch {
    return NextResponse.json({ error: "api_unavailable" }, { status: 503 });
  }
}
