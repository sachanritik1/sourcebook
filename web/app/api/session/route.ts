import { NextRequest, NextResponse } from "next/server";
import {
  backend,
  currentSession,
  forbidden,
  readJson,
  unauthorized,
  validOrigin,
} from "@/lib/backend";
import {
  cookieOptions,
  sealSession,
  SESSION_COOKIE,
  Session,
} from "@/lib/session";

export const runtime = "nodejs";

export function GET(request: NextRequest): NextResponse {
  const session = currentSession(request);
  if (!session) return unauthorized();
  return NextResponse.json({ userId: session.userId, email: session.email });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (
    (input.action !== "login" && input.action !== "register") ||
    typeof input.email !== "string" ||
    typeof input.password !== "string"
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const response = await backend(`/auth/${input.action}`, {
    method: "POST",
    body: { email: input.email, password: input.password },
  });
  if (!response.ok) return response;
  const session = (await response.json()) as Session;
  const result = NextResponse.json(
    { userId: session.userId, email: session.email },
    { status: response.status },
  );
  result.cookies.set(
    SESSION_COOKIE,
    sealSession(session),
    cookieOptions(session.expiresAt),
  );
  return result;
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  const session = currentSession(request);
  if (session) {
    const response = await backend("/auth/logout", {
      method: "POST",
      token: session.token,
    });
    if (response.status !== 204 && response.status !== 401) return response;
  }
  const result = new NextResponse(null, { status: 204 });
  result.cookies.delete(SESSION_COOKIE);
  return result;
}
