import { NextRequest, NextResponse } from "next/server";
import {
  backend,
  currentSession,
  forbidden,
  notFound,
  unauthorized,
  validOrigin,
  validUuid,
} from "@/lib/backend";
import { readUpload, UploadError } from "@/lib/upload";

export const runtime = "nodejs";

type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  const { workspaceId } = await context.params;
  if (!validUuid(workspaceId)) return notFound();
  const session = currentSession(request);
  if (!session) return unauthorized();
  return backend(`/workspaces/${workspaceId}/documents`, {
    method: "GET",
    token: session.token,
  });
}

export async function POST(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  const { workspaceId } = await context.params;
  if (!validUuid(workspaceId)) return notFound();
  const session = currentSession(request);
  if (!session) return unauthorized();
  const key = request.headers.get("idempotency-key");
  if (!key || !validUuid(key)) {
    return NextResponse.json(
      { error: "invalid_idempotency_key" },
      { status: 400 },
    );
  }
  let file: File;
  try {
    file = await readUpload(request);
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "invalid_upload" }, { status: 400 });
  }
  const form = new FormData();
  form.append("file", file, file.name);
  return backend(`/workspaces/${workspaceId}/documents`, {
    method: "POST",
    token: session.token,
    form,
    idempotencyKey: key,
  });
}
