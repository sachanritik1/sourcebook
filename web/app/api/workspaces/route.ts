import { NextRequest, NextResponse } from "next/server";
import {
  backend,
  currentSession,
  forbidden,
  readJson,
  unauthorized,
  validOrigin,
} from "@/lib/backend";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = currentSession(request);
  if (!session) return unauthorized();
  return backend("/workspaces", { method: "GET", token: session.token });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  const session = currentSession(request);
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).name !== "string"
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  return backend("/workspaces", {
    method: "POST",
    token: session.token,
    body: { name: (body as { name: string }).name },
  });
}
