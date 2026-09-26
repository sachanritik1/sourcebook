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

export const runtime = "nodejs";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  if (!validOrigin(request)) return forbidden();
  const { jobId } = await context.params;
  if (!validUuid(jobId)) return notFound();
  const session = currentSession(request);
  if (!session) return unauthorized();
  return backend(`/jobs/${jobId}/retry`, {
    method: "POST",
    token: session.token,
  });
}
