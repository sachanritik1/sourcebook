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

type Context = {
  params: Promise<{ workspaceId: string; documentId: string }>;
};

export async function DELETE(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  const { workspaceId, documentId } = await context.params;
  if (!validUuid(workspaceId) || !validUuid(documentId)) return notFound();
  const session = currentSession(request);
  if (!session) return unauthorized();
  return backend(`/workspaces/${workspaceId}/documents/${documentId}`, {
    method: "DELETE",
    token: session.token,
  });
}
