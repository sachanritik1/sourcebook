import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DelayedError, Queue, UnrecoverableError, type Job } from "bullmq";
import IORedis from "ioredis";
import request from "supertest";
import { createApp } from "../../src/app";
import {
  LocalLexicalEmbeddings,
  type EmbeddingProvider,
} from "../../src/ai/embeddings";
import { FixedWindowLimiter } from "../../src/rate-limit/fixed-window";
import { limitEmbeddings } from "../../src/ai/provider-budget";
import {
  citedAnswer,
  InvalidCitationError,
  LocalExtractiveAnswers,
  type AnswerProvider,
} from "../../src/ai/answers";
import { questionFingerprint } from "../../src/ai/question-requests";
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
import { processQueuedDocument } from "../../src/processing/worker";
import { PROVIDER_AWARE_BACKOFF } from "../../src/processing/backoff";

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
  const embeddings = new LocalLexicalEmbeddings();
  const answers = new LocalExtractiveAnswers();
  const app =
    pool && redis
      ? createApp(pool, {
          embeddings,
          limiter: new FixedWindowLimiter(redis, 1000, "search-test"),
          answers,
          answerLimiter: new FixedWindowLimiter(redis, 1000, "question-test"),
        })
      : null;

  beforeAll(async () => {
    await migrate(databaseUrl!);
  });

  beforeEach(async () => {
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

  function appWithPendingLimit(limit: number) {
    const previous = process.env.MAX_PENDING_JOBS_PER_WORKSPACE;
    process.env.MAX_PENDING_JOBS_PER_WORKSPACE = String(limit);
    try {
      return createApp(pool!);
    } finally {
      if (previous === undefined)
        delete process.env.MAX_PENDING_JOBS_PER_WORKSPACE;
      else process.env.MAX_PENDING_JOBS_PER_WORKSPACE = previous;
    }
  }

  it("returns the original IDs for concurrent upload replays, including when full", async () => {
    const { owner, outsider, workspaceId } = await setup();
    const capped = appWithPendingLimit(1);
    const key = randomUUID();
    const upload = () =>
      request(capped)
        .post(`/workspaces/${workspaceId}/documents`)
        .set("Idempotency-Key", key)
        .auth(owner.body.token, { type: "bearer" })
        .attach("file", Buffer.from("Exactly one uploaded document."), {
          filename: "same.txt",
          contentType: "text/plain",
        });
    const responses = await Promise.all([upload(), upload()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 202,
    ]);
    expect(responses[0].body.documentId).toBe(responses[1].body.documentId);
    expect(responses[0].body.jobId).toBe(responses[1].body.jobId);
    const counts = await pool!.query(
      `SELECT (SELECT count(*)::int FROM documents WHERE workspace_id = $1) AS documents,
              (SELECT count(*)::int FROM processing_jobs WHERE workspace_id = $1) AS jobs,
              (SELECT count(*)::int FROM outbox_events WHERE workspace_id = $1) AS events`,
      [workspaceId],
    );
    expect(counts.rows[0]).toEqual({ documents: 1, jobs: 1, events: 1 });
    await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", key)
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Different bytes"), {
        filename: "same.txt",
        contentType: "text/plain",
      })
      .expect(409);
    await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Missing key"), {
        filename: "missing.txt",
        contentType: "text/plain",
      })
      .expect(400);
    await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", key)
      .auth(outsider.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Exactly one uploaded document."), {
        filename: "same.txt",
        contentType: "text/plain",
      })
      .expect(404);
    const other = await setup();
    await request(capped)
      .post(`/workspaces/${other.workspaceId}/documents`)
      .set("Idempotency-Key", key)
      .auth(other.owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Different workspace"), {
        filename: "other.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const row = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [responses[0].body.jobId],
    );
    await processDocumentEvent(
      pool!,
      row.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    const finishedReplay = await upload().expect(200);
    expect(finishedReplay.body).toMatchObject({
      documentId: responses[0].body.documentId,
      jobId: responses[0].body.jobId,
      status: "completed",
    });
  });

  it("admits only one of two concurrent uploads at the last workspace slot", async () => {
    const { owner, workspaceId } = await setup();
    const capped = appWithPendingLimit(1);
    const uploads = await Promise.all(
      ["first", "second"].map((name) =>
        request(capped)
          .post(`/workspaces/${workspaceId}/documents`)
          .set("Idempotency-Key", randomUUID())
          .auth(owner.body.token, { type: "bearer" })
          .attach("file", Buffer.from(`${name} admission evidence`), {
            filename: `${name}.txt`,
            contentType: "text/plain",
          }),
      ),
    );
    expect(uploads.map((response) => response.status).sort()).toEqual([
      202, 429,
    ]);
    expect(
      uploads.find((response) => response.status === 429)?.body.error,
    ).toBe("workspace_job_limit");
    const rows = await pool!.query(
      `SELECT count(*)::int AS count FROM processing_jobs WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(rows.rows[0].count).toBe(1);
    const atomic = await pool!.query(
      `SELECT (SELECT count(*)::int FROM documents WHERE workspace_id = $1) AS documents,
              (SELECT count(*)::int FROM outbox_events WHERE workspace_id = $1) AS events`,
      [workspaceId],
    );
    expect(atomic.rows[0]).toEqual({ documents: 1, events: 1 });
    const other = await setup();
    await request(capped)
      .post(`/workspaces/${other.workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(other.owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("other workspace"), {
        filename: "other.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const accepted = uploads.find((response) => response.status === 202)!;
    const event = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [accepted.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      event.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("capacity released"), {
        filename: "released.txt",
        contentType: "text/plain",
      })
      .expect(202);
  });

  it("applies workspace capacity to reindex and failed-job retry", async () => {
    const { owner, workspaceId } = await setup();
    const capped = appWithPendingLimit(1);
    const upload = await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("reindex capacity"), {
        filename: "reindex-capacity.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const event = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      event.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    const queued = await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("retry capacity"), {
        filename: "retry-capacity.txt",
        contentType: "text/plain",
      })
      .expect(202);
    await request(capped)
      .post(
        `/workspaces/${workspaceId}/documents/${upload.body.documentId}/reindex`,
      )
      .auth(owner.body.token, { type: "bearer" })
      .expect(429);
    const queuedEvent = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [queued.body.jobId],
    );
    await recordFailure(
      pool!,
      queuedEvent.rows[0].payload as DocumentEvent,
      3,
      3,
      new Error("forced failure"),
    );
    await request(capped)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("occupy slot"), {
        filename: "occupy.txt",
        contentType: "text/plain",
      })
      .expect(202);
    await request(capped)
      .post(`/jobs/${queued.body.jobId}/retry`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(429);
    const stillFailed = await pool!.query(
      "SELECT status FROM processing_jobs WHERE id = $1",
      [queued.body.jobId],
    );
    expect(stillFailed.rows[0].status).toBe("failed");
  });

  it("commits upload and outbox together, publishes replay safely, and processes once", async () => {
    const { owner, outsider, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
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
    expect(redisJob?.opts.backoff).toMatchObject({
      type: PROVIDER_AWARE_BACKOFF,
    });
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
        processDocumentEvent(pool!, event, 1, embeddings),
      ).rejects.toBeInstanceOf(WorkspaceBusyError);
    } finally {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
        [workspaceId],
      );
      lockClient.release();
    }
    await processDocumentEvent(pool!, event, 1, embeddings);
    await processDocumentEvent(pool!, event, 1, embeddings);
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
    const vectors = await pool!.query(
      "SELECT chunk_id FROM document_embeddings WHERE workspace_id = $1 AND model = $2",
      [workspaceId, embeddings.model],
    );
    expect(vectors.rowCount).toBe(1);
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
      .set("Idempotency-Key", randomUUID())
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
    await processDocumentEvent(pool!, event, 1, embeddings);
    const stillQueued = await pool!.query(
      "SELECT status FROM processing_jobs WHERE id = $1",
      [jobId],
    );
    expect(stillQueued.rows[0].status).toBe("queued");
  });

  it("scopes vector results and usage to the member workspace", async () => {
    const first = await setup();
    const second = await setup();
    const uploads = await Promise.all([
      request(app!)
        .post(`/workspaces/${first.workspaceId}/documents`)
        .set("Idempotency-Key", randomUUID())
        .auth(first.owner.body.token, { type: "bearer" })
        .attach("file", Buffer.from("Orchid satellite evidence"), {
          filename: "first.txt",
          contentType: "text/plain",
        })
        .expect(202),
      request(app!)
        .post(`/workspaces/${second.workspaceId}/documents`)
        .set("Idempotency-Key", randomUUID())
        .auth(second.owner.body.token, { type: "bearer" })
        .attach("file", Buffer.from("Orchid satellite evidence"), {
          filename: "second.txt",
          contentType: "text/plain",
        })
        .expect(202),
    ]);
    for (const upload of uploads) {
      const row = await pool!.query(
        "SELECT payload FROM outbox_events WHERE job_id = $1",
        [upload.body.jobId],
      );
      await processDocumentEvent(
        pool!,
        row.rows[0].payload as DocumentEvent,
        1,
        embeddings,
      );
    }
    const own = await request(app!)
      .post(`/workspaces/${first.workspaceId}/search`)
      .auth(first.owner.body.token, { type: "bearer" })
      .send({ query: "orchid satellite", topK: 10 })
      .expect(200);
    expect(own.body.results).toHaveLength(1);
    expect(own.body.results[0].documentId).toBe(uploads[0].body.documentId);
    await request(app!)
      .post(`/workspaces/${first.workspaceId}/search`)
      .auth(second.owner.body.token, { type: "bearer" })
      .send({ query: "orchid satellite" })
      .expect(404);
    await request(app!)
      .get(`/workspaces/${first.workspaceId}/usage`)
      .auth(second.owner.body.token, { type: "bearer" })
      .expect(404);
    const usage = await request(app!)
      .get(`/workspaces/${first.workspaceId}/usage`)
      .auth(first.owner.body.token, { type: "bearer" })
      .expect(200);
    expect(
      usage.body.usage.map((row: { operation: string }) => row.operation),
    ).toEqual(["embedding_index", "embedding_search"]);

    const answer = await request(app!)
      .post(`/workspaces/${first.workspaceId}/questions`)
      .set("Idempotency-Key", randomUUID())
      .auth(first.owner.body.token, { type: "bearer" })
      .send({ question: "What is the orchid evidence?" })
      .expect(200);
    expect(answer.body.answer).toContain("Orchid satellite evidence");
    expect(answer.body.citations).toEqual([
      {
        chunkId: own.body.results[0].chunkId,
        documentId: uploads[0].body.documentId,
        filename: "first.txt",
        ordinal: 0,
        excerpt: "Orchid satellite evidence",
      },
    ]);
    await request(app!)
      .post(`/workspaces/${first.workspaceId}/questions`)
      .set("Idempotency-Key", randomUUID())
      .auth(second.owner.body.token, { type: "bearer" })
      .send({ question: "What is the orchid evidence?" })
      .expect(404);
    const afterAnswer = await request(app!)
      .get(`/workspaces/${first.workspaceId}/usage`)
      .auth(first.owner.body.token, { type: "bearer" })
      .expect(200);
    expect(
      afterAnswer.body.usage.map((row: { operation: string }) => row.operation),
    ).toEqual(["embedding_index", "embedding_search", "llm_answer"]);
  });

  it("rejects provider citations outside retrieved chunks", () => {
    const chunk = {
      chunkId: randomUUID(),
      documentId: randomUUID(),
      filename: "private.txt",
      ordinal: 0,
      content: "Private evidence",
      score: 1,
    };
    expect(() =>
      citedAnswer(
        {
          answer: "Unsupported claim",
          insufficientEvidence: false,
          citations: [2],
          inputTokens: 12,
          outputTokens: 3,
        },
        [chunk],
      ),
    ).toThrow(InvalidCitationError);
  });

  it("replays one concurrent question and records provider usage once", async () => {
    const { owner, outsider, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Orchid evidence is in this note."), {
        filename: "source.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const event = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      event.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    let providerCalls = 0;
    let releaseProvider = () => {};
    let providerEntered = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const delayedAnswers: AnswerProvider = {
      ...answers,
      answer: async (question, chunks) => {
        providerCalls++;
        providerEntered();
        await gate;
        return answers.answer(question, chunks);
      },
    };
    const answerApp = createApp(pool!, {
      embeddings,
      limiter: new FixedWindowLimiter(redis!, 1000, "search-replay-test"),
      answers: delayedAnswers,
      answerLimiter: new FixedWindowLimiter(
        redis!,
        1000,
        "question-replay-test",
      ),
    });
    const key = randomUUID();
    const ask = (question: string) =>
      request(answerApp)
        .post(`/workspaces/${workspaceId}/questions`)
        .set("Idempotency-Key", key)
        .auth(owner.body.token, { type: "bearer" })
        .send({ question });
    const first = ask("What does the orchid note say?").then(
      (result) => result,
    );
    try {
      await entered;
      const pending = await ask("What does the orchid note say?").expect(409);
      expect(pending.body.error).toBe("question_in_progress");
      const mismatch = await ask("What is different?").expect(409);
      expect(mismatch.body.error).toBe("idempotency_key_reused");
      await request(answerApp)
        .post(`/workspaces/${workspaceId}/questions`)
        .set("Idempotency-Key", key)
        .auth(outsider.body.token, { type: "bearer" })
        .send({ question: "What does the orchid note say?" })
        .expect(404);
      await pool!.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, outsider.body.userId],
      );
      const anotherMember = await request(answerApp)
        .post(`/workspaces/${workspaceId}/questions`)
        .set("Idempotency-Key", key)
        .auth(outsider.body.token, { type: "bearer" })
        .send({ question: "What does the orchid note say?" })
        .expect(409);
      expect(anotherMember.body.error).toBe("idempotency_key_reused");
    } finally {
      releaseProvider();
    }
    const completed = await first;
    expect(completed.status).toBe(200);
    const replayed = await ask("What does the orchid note say?").expect(200);
    expect(replayed.body).toEqual(completed.body);
    expect(providerCalls).toBe(1);
    const usage = await pool!.query(
      "SELECT operation, count(*)::int AS count FROM usage_events WHERE workspace_id = $1 AND event_key LIKE $2 GROUP BY operation ORDER BY operation",
      [workspaceId, `${key}:%`],
    );
    expect(usage.rows).toEqual([
      { operation: "embedding_search", count: 1 },
      { operation: "llm_answer", count: 1 },
    ]);
  });

  it("does not rerun a question with an uncertain or stale reservation", async () => {
    const { owner, workspaceId } = await setup();
    const question = "What evidence exists?";
    for (const [status, age] of [
      ["uncertain", "now()"],
      ["in_progress", "now() - interval '3 minutes'"],
    ]) {
      const key = randomUUID();
      await pool!.query(
        `INSERT INTO question_requests
         (workspace_id, idempotency_key, user_id, request_fingerprint, status, created_at)
         VALUES ($1, $2, $3, $4, $5, ${age})`,
        [
          workspaceId,
          key,
          owner.body.userId,
          questionFingerprint(question, 5),
          status,
        ],
      );
      const blocked = await request(app!)
        .post(`/workspaces/${workspaceId}/questions`)
        .set("Idempotency-Key", key)
        .auth(owner.body.token, { type: "bearer" })
        .send({ question })
        .expect(409);
      expect(blocked.body.error).toBe("question_outcome_unknown");
    }
    const usage = await pool!.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(usage.rows[0].count).toBe(0);
  });

  it("rejects an invalid provider citation at the API boundary and records usage", async () => {
    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Citation boundary evidence."), {
        filename: "source.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const row = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      row.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    const badProvider: AnswerProvider = {
      model: "bad-provider-test",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
      answer: async () => ({
        answer: "Claim",
        insufficientEvidence: false,
        citations: [2],
        inputTokens: 10,
        outputTokens: 2,
      }),
    };
    const badApp = createApp(pool!, {
      embeddings,
      limiter: new FixedWindowLimiter(redis!, 1000, "search-bad-test"),
      answers: badProvider,
      answerLimiter: new FixedWindowLimiter(redis!, 1000, "question-bad-test"),
    });
    const response = await request(badApp)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What is the citation boundary?" })
      .expect(502);
    expect(response.body.error).toBe("invalid_provider_citation");
    const usage = await pool!.query(
      "SELECT input_tokens, output_tokens FROM usage_events WHERE workspace_id = $1 AND operation = 'llm_answer'",
      [workspaceId],
    );
    expect(usage.rows).toEqual([{ input_tokens: 10, output_tokens: 2 }]);
  });

  it("does not call the answer provider when no chunks are indexed", async () => {
    const { owner, workspaceId } = await setup();
    const key = randomUUID();
    const answer = await request(app!)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", key)
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What evidence exists?" })
      .expect(200);
    expect(answer.body.citations).toEqual([]);
    expect(answer.body.answer).toContain("could not find enough evidence");
    const replayed = await request(app!)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", key)
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What evidence exists?" })
      .expect(200);
    expect(replayed.body).toEqual(answer.body);
    const usage = await request(app!)
      .get(`/workspaces/${workspaceId}/usage`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(200);
    expect(
      usage.body.usage.map((row: { operation: string }) => row.operation),
    ).toEqual(["embedding_search"]);
    const count = await pool!.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE event_key = $1",
      [`${key}:embedding`],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("resumes after a failed embedding batch without repeating committed batches", async () => {
    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("recovery marker ".repeat(2300)), {
        filename: "long.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const row = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    const event = row.rows[0].payload as DocumentEvent;
    const batchSizes: number[] = [];
    let failOnce = true;
    const flaky: EmbeddingProvider = {
      model: embeddings.model,
      usdPerMillionTokens: embeddings.usdPerMillionTokens,
      embed: async (inputs) => {
        batchSizes.push(inputs.length);
        if (batchSizes.length === 2 && failOnce) {
          failOnce = false;
          throw new Error("provider temporarily unavailable");
        }
        return embeddings.embed(inputs);
      },
    };
    await expect(processDocumentEvent(pool!, event, 1, flaky)).rejects.toThrow(
      "provider temporarily unavailable",
    );
    const saved = await pool!.query(
      "SELECT count(*)::int AS count FROM document_embeddings WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(saved.rows[0].count).toBe(32);
    await recordFailure(
      pool!,
      event,
      1,
      3,
      new Error("provider temporarily unavailable"),
    );
    await processDocumentEvent(pool!, event, 2, flaky);
    expect(batchSizes[0]).toBe(32);
    expect(batchSizes[1]).toBeLessThan(32);
    expect(batchSizes[2]).toBe(batchSizes[1]);
    const usage = await pool!.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE job_id = $1",
      [event.jobId],
    );
    expect(usage.rows[0].count).toBe(2);
    await processDocumentEvent(pool!, event, 2, flaky);
    expect(batchSizes).toHaveLength(3);
  });

  it("creates a new event to reindex a completed document", async () => {
    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("reindex evidence"), {
        filename: "reindex.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const first = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      first.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    const reindex = await request(app!)
      .post(
        `/workspaces/${workspaceId}/documents/${upload.body.documentId}/reindex`,
      )
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    expect(reindex.body.jobId).not.toBe(upload.body.jobId);
    const second = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [reindex.body.jobId],
    );
    const differentModel: EmbeddingProvider = {
      model: "local-lexical-v2",
      usdPerMillionTokens: 0,
      embed: (inputs) => embeddings.embed(inputs),
    };
    await processDocumentEvent(
      pool!,
      second.rows[0].payload as DocumentEvent,
      1,
      differentModel,
    );
    const vectors = await pool!.query(
      "SELECT DISTINCT model FROM document_embeddings WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(
      vectors.rows.map((row: { model: string }) => row.model).sort(),
    ).toEqual(["local-lexical-v1", "local-lexical-v2"]);
  });

  it("enforces a shared per-workspace search budget in Redis", async () => {
    const limiter = new FixedWindowLimiter(redis!, 2, "search-test-limit");
    const workspaceId = randomUUID();
    expect(await limiter.take(workspaceId)).toBe(true);
    expect(await limiter.take(workspaceId)).toBe(true);
    expect(await limiter.take(workspaceId)).toBe(false);
    expect(await limiter.take(randomUUID())).toBe(true);
  });

  it("defers a worker when provider capacity is full without recording a failed attempt", async () => {
    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Provider capacity checkpoint."), {
        filename: "capacity.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const row = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    const event = row.rows[0].payload as DocumentEvent;
    let delayedUntil = 0;
    const job = {
      data: event,
      attemptsMade: 0,
      opts: { attempts: 3 },
      moveToDelayed: async (until: number) => {
        delayedUntil = until;
      },
    } as unknown as Job<DocumentEvent>;
    const limited = limitEmbeddings(embeddings, {
      take: async () => false,
    });
    await expect(
      processQueuedDocument(pool!, job, "test-lock", limited),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(delayedUntil).toBeGreaterThan(Date.now());
    const current = await pool!.query(
      `SELECT status, attempts_made AS attempts,
       (SELECT count(*)::int FROM dead_letter_jobs WHERE job_id = $1) AS dead_letters
       FROM processing_jobs WHERE id = $1`,
      [upload.body.jobId],
    );
    expect(current.rows[0]).toEqual({
      status: "processing",
      attempts: 1,
      dead_letters: 0,
    });
    await processQueuedDocument(pool!, job, "test-lock", embeddings);
    const completed = await pool!.query(
      "SELECT status FROM processing_jobs WHERE id = $1",
      [upload.body.jobId],
    );
    expect(completed.rows[0].status).toBe("completed");
  });

  it("dead-letters a provider quota error without spending the remaining attempts", async () => {
    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Provider quota example."), {
        filename: "quota.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const row = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    const job = {
      data: row.rows[0].payload as DocumentEvent,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job<DocumentEvent>;
    const quotaError = Object.assign(new Error("credits exhausted"), {
      status: 429,
      code: "credit_balance_exhausted",
    });
    const quotaProvider: EmbeddingProvider = {
      model: embeddings.model,
      usdPerMillionTokens: 0,
      embed: async () => {
        throw quotaError;
      },
    };
    await expect(
      processQueuedDocument(pool!, job, "test-lock", quotaProvider),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const result = await pool!.query(
      `SELECT status, attempts_made AS attempts,
       (SELECT count(*)::int FROM dead_letter_jobs WHERE job_id = $1) AS dead_letters
       FROM processing_jobs WHERE id = $1`,
      [upload.body.jobId],
    );
    expect(result.rows[0]).toEqual({
      status: "failed",
      attempts: 1,
      dead_letters: 1,
    });
    // A replay after the DB commit but before BullMQ marks the job failed stays terminal.
    await processDocumentEvent(pool!, job.data, 2, embeddings);
    const replayed = await pool!.query(
      "SELECT status, attempts_made FROM processing_jobs WHERE id = $1",
      [upload.body.jobId],
    );
    expect(replayed.rows[0]).toEqual({ status: "failed", attempts_made: 1 });
  });

  it("protects operational metrics and reports persisted work and usage", async () => {
    const token = "test-metrics-token-with-at-least-32-characters";
    const meteredAnswers: AnswerProvider = {
      model: "metered-test-answer",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
      answer: async (question, chunks) => ({
        ...(await answers.answer(question, chunks)),
        inputTokens: 12,
        outputTokens: 3,
      }),
    };
    const metricsApp = createApp(pool!, {
      embeddings,
      limiter: new FixedWindowLimiter(redis!, 1000, "metrics-search-test"),
      answers: meteredAnswers,
      answerLimiter: new FixedWindowLimiter(
        redis!,
        1000,
        "metrics-answer-test",
      ),
      metrics: { queue: queue!, token },
    });
    await request(metricsApp).get("/internal/metrics").expect(401);
    await request(metricsApp)
      .get("/internal/metrics")
      .auth("wrong-token", { type: "bearer" })
      .expect(401);
    const empty = await request(metricsApp)
      .get("/internal/metrics")
      .auth(token, { type: "bearer" })
      .expect(200);
    expect(empty.body.jobs.averageEndToEndMs).toBeNull();
    expect(empty.body.usage.averageAnswerLatencyMs).toBeNull();
    const unavailableApp = createApp(pool!, {
      embeddings,
      limiter: new FixedWindowLimiter(redis!, 1000, "metrics-error-test"),
      metrics: {
        token,
        queue: {
          getJobCounts: async () => {
            throw new Error("Redis unavailable");
          },
        },
      },
    });
    const unavailable = await request(unavailableApp)
      .get("/internal/metrics")
      .auth(token, { type: "bearer" })
      .expect(503);
    expect(unavailable.body.error).toBe("metrics_unavailable");

    const { owner, workspaceId } = await setup();
    const upload = await request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("A reliable answer comes from a document."), {
        filename: "metrics.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const event = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [upload.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      event.rows[0].payload as DocumentEvent,
      1,
      embeddings,
    );
    await request(metricsApp)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "Where does a reliable answer come from?" })
      .expect(200);
    await pool!.query(
      "UPDATE processing_jobs SET attempts_made = 2 WHERE id = $1",
      [upload.body.jobId],
    );
    const metrics = await request(metricsApp)
      .get("/internal/metrics")
      .auth(token, { type: "bearer" })
      .expect(200);
    expect(metrics.body.queue.waiting).toBe(0);
    expect(metrics.body.jobs).toMatchObject({
      queued: 0,
      completed: 1,
      failed: 0,
      retryAttemptsCurrentEvent: 1,
    });
    expect(metrics.body.jobs.averageEndToEndMs).toBeGreaterThanOrEqual(0);
    expect(metrics.body.outbox.pending).toBe(1);
    expect(metrics.body.usage).toMatchObject({ answerCalls: 1 });
    expect(metrics.body.usage.answerInputTokens).toBe(12);
    expect(metrics.body.usage.answerOutputTokens).toBe(3);
    expect(metrics.body.usage.averageAnswerLatencyMs).toBeGreaterThanOrEqual(0);
    const stored = await pool!.query(
      "SELECT provider_latency_ms FROM usage_events WHERE operation = 'llm_answer'",
    );
    expect(stored.rows[0].provider_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("extracts text from a real PDF byte stream", async () => {
    expect(await extractText(samplePdf(), "application/pdf")).toContain(
      "Reliable document processing",
    );
  });
});
