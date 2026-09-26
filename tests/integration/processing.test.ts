import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import request from "supertest";
import { createApp } from "../../src/app";
import { migrate } from "../../src/db/migrate";
import { createPool } from "../../src/db/pool";
import { extractText } from "../../src/processing/extract";
import {
  processDocumentEvent,
  recordFailure,
  WorkspaceBusyError,
} from "../../src/processing/processor";
import { publishPending, reconcileJobs } from "../../src/processing/publisher";
import type { DocumentEvent } from "../../src/processing/types";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

function samplePdf(): Buffer {
  const stream = "BT /F1 18 Tf 72 720 Td (Reliable document processing) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

describe.skipIf(!databaseUrl || !redisUrl)("document processing", () => {
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  const redis = redisUrl ? new IORedis(redisUrl) : null;
  const queue = redis
    ? new Queue("document-processing-integration", { connection: redis })
    : null;
  const app = pool ? createApp(pool) : null;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    await pool!.query(
      "TRUNCATE dead_letter_jobs, processed_events, document_chunks, outbox_events, processing_jobs, documents, sessions, workspace_memberships, workspaces, users CASCADE",
    );
    await queue!.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    await redis?.quit();
    await pool?.end();
  });

  async function setup() {
    const owner = await request(app!)
      .post("/auth/register")
      .send({
        email: `owner-${Date.now()}@example.com`,
        password: "a-long-test-password",
      })
      .expect(201);
    const outsider = await request(app!)
      .post("/auth/register")
      .send({
        email: `outsider-${Date.now()}@example.com`,
        password: "another-test-password",
      })
      .expect(201);
    const workspace = await request(app!)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Research" })
      .expect(201);
    return { owner, outsider, workspaceId: workspace.body.id as string };
  }

  it("commits upload and outbox together, publishes replay safely, and processes once", async () => {
    const { owner, outsider, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Alpha evidence. Beta evidence."), {
        filename: "notes.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const { documentId, jobId } = upload.body;
    const stored = await pool!.query(
      "SELECT id FROM outbox_events WHERE job_id = $1",
      [jobId],
    );
    expect(stored.rowCount).toBe(1);
    const eventId = stored.rows[0].id as string;

    await request(app!)
      .get(`/jobs/${jobId}`)
      .auth(outsider.body.token, { type: "bearer" })
      .expect(404);
    await request(app!)
      .get(`/workspaces/${workspaceId}/documents/${documentId}`)
      .auth(outsider.body.token, { type: "bearer" })
      .expect(404);
    await request(app!)
      .get(`/workspaces/${workspaceId}/documents`)
      .auth(outsider.body.token, { type: "bearer" })
      .expect(404);
    const ownerDocuments = await request(app!)
      .get(`/workspaces/${workspaceId}/documents`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(200);
    expect(ownerDocuments.body.documents[0].id).toBe(documentId);
    await request(app!)
      .post(`/jobs/${jobId}/retry`)
      .auth(outsider.body.token, { type: "bearer" })
      .expect(404);

    const unavailableQueue = {
      add: async () => {
        throw new Error("Redis unavailable");
      },
    } as unknown as Pick<Queue, "add">;
    expect(await publishPending(pool!, unavailableQueue)).toBe(1);
    const unpublished = await pool!.query(
      "SELECT published_at, delivery_attempts FROM outbox_events WHERE id = $1",
      [eventId],
    );
    expect(unpublished.rows[0]).toMatchObject({
      published_at: null,
      delivery_attempts: 1,
    });
    await pool!.query(
      "UPDATE outbox_events SET locked_until = NULL WHERE id = $1",
      [eventId],
    );
    expect(await publishPending(pool!, queue!)).toBe(1);
    await pool!.query(
      "UPDATE outbox_events SET published_at = NULL WHERE id = $1",
      [eventId],
    );
    expect(await publishPending(pool!, queue!)).toBe(1);
    const redisJob = await queue!.getJob(eventId);
    expect(redisJob?.id).toBe(eventId);
    expect((await queue!.getJobCounts()).waiting).toBe(1);

    await redisJob!.remove();
    await pool!.query(
      "UPDATE processing_jobs SET updated_at = now() - interval '3 minutes' WHERE id = $1",
      [jobId],
    );
    expect(await reconcileJobs(pool!, queue!)).toBe(1);
    const republish = await pool!.query(
      "SELECT published_at FROM outbox_events WHERE id = $1",
      [eventId],
    );
    expect(republish.rows[0].published_at).toBeNull();
    expect(await publishPending(pool!, queue!)).toBe(1);

    const event = (await queue!.getJob(eventId))!.data as DocumentEvent;
    const lockClient = await pool!.connect();
    try {
      await lockClient.query(
        "SELECT pg_advisory_lock(hashtextextended($1::text, 0))",
        [workspaceId],
      );
      await expect(
        processDocumentEvent(pool!, event, 1),
      ).rejects.toBeInstanceOf(WorkspaceBusyError);
    } finally {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
        [workspaceId],
      );
      lockClient.release();
    }
    await processDocumentEvent(pool!, event, 1);
    await processDocumentEvent(pool!, event, 1);
    const chunks = await pool!.query(
      "SELECT ordinal, content FROM document_chunks WHERE workspace_id = $1 AND document_id = $2",
      [workspaceId, documentId],
    );
    expect(chunks.rows).toHaveLength(1);
    expect(chunks.rows[0].content).toContain("Alpha evidence");
    const markers = await pool!.query(
      "SELECT event_id FROM processed_events WHERE event_id = $1",
      [eventId],
    );
    expect(markers.rowCount).toBe(1);
    const completed = await request(app!)
      .get(`/jobs/${jobId}`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      stage: "done",
      progress: 100,
    });
  });

  it("dead-letters after the retry budget and manual retry creates a new event", async () => {
    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("%PDF-broken"), {
        filename: "broken.pdf",
        contentType: "application/pdf",
      })
      .expect(202);
    const jobId = upload.body.jobId as string;
    const row = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [jobId],
    );
    const event = row.rows[0].payload as DocumentEvent;
    for (const attempt of [1, 2, 3]) {
      await recordFailure(
        pool!,
        event,
        attempt,
        3,
        new Error("PDF could not be parsed"),
      );
    }
    const failed = await request(app!)
      .get(`/jobs/${jobId}`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(200);
    expect(failed.body).toMatchObject({
      status: "failed",
      stage: "dead_letter",
      attemptsMade: 3,
    });
    const dead = await pool!.query(
      "SELECT event_id FROM dead_letter_jobs WHERE job_id = $1",
      [jobId],
    );
    expect(dead.rows).toEqual([{ event_id: event.eventId }]);
    await request(app!)
      .post(`/jobs/${jobId}/retry`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    const current = await pool!.query(
      "SELECT current_event_id, status FROM processing_jobs WHERE id = $1",
      [jobId],
    );
    expect(current.rows[0].current_event_id).not.toBe(event.eventId);
    expect(current.rows[0].status).toBe("queued");
    await processDocumentEvent(pool!, event, 1);
    const stillQueued = await pool!.query(
      "SELECT status FROM processing_jobs WHERE id = $1",
      [jobId],
    );
    expect(stillQueued.rows[0].status).toBe("queued");
  });

  it("extracts text from a real PDF byte stream", async () => {
    expect(await extractText(samplePdf(), "application/pdf")).toContain(
      "Reliable document processing",
    );
  });
});
