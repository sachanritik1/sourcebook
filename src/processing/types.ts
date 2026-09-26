import { z } from "zod";

export const documentEventSchema = z.object({
  eventId: z.uuid(),
  workspaceId: z.uuid(),
  documentId: z.uuid(),
  jobId: z.uuid(),
  requestId: z.string().min(1),
});

export type DocumentEvent = z.infer<typeof documentEventSchema>;
export const QUEUE_NAME = "document-processing";

export function configuredMaxAttempts(): number {
  const value = Number(process.env.MAX_PROCESSING_ATTEMPTS ?? 3);
  if (!Number.isInteger(value) || value < 1 || value > 10)
    throw new Error("MAX_PROCESSING_ATTEMPTS must be an integer from 1 to 10");
  return value;
}
