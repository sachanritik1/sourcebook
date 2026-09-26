import { NextRequest, NextResponse } from "next/server";
import {
  backend,
  currentSession,
  forbidden,
  notFound,
  readJson,
  unauthorized,
  validOrigin,
  validUuid,
} from "@/lib/backend";

export const runtime = "nodejs";

type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  const { workspaceId } = await context.params;
  if (!validUuid(workspaceId)) return notFound();
  const session = currentSession(request);
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const question =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).question
      : undefined;
  if (
    typeof question !== "string" ||
    question.trim().length === 0 ||
    question.length > 2000
  ) {
    return NextResponse.json({ error: "invalid_question" }, { status: 400 });
  }
  return backend(`/workspaces/${workspaceId}/questions`, {
    method: "POST",
    token: session.token,
    body: { question: question.trim() },
    timeoutMs: 70_000,
  });
}
