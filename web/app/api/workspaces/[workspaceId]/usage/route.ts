import { NextRequest, NextResponse } from "next/server";
import {
  backend,
  currentSession,
  notFound,
  unauthorized,
  validUuid,
} from "@/lib/backend";

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
  return backend(`/workspaces/${workspaceId}/usage`, {
    method: "GET",
    token: session.token,
  });
}
