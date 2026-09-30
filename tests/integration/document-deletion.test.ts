import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Pool } from "pg";
import { createApp } from "../../src/app";
import { LocalLexicalEmbeddings } from "../../src/ai/embeddings";
import {
  LocalExtractiveAnswers,
  type AnswerProvider,
} from "../../src/ai/answers";
import {
  completeQuestion,
  reserveQuestion,
} from "../../src/ai/question-requests";
import { migrate } from "../../src/db/migrate";
import { createPool } from "../../src/db/pool";
import {
  expireDocuments,
  processDocumentDeletions,
} from "../../src/documents/deletion";
import { processDocumentEvent } from "../../src/processing/processor";
import type { DocumentEvent } from "../../src/processing/types";
import type { ObjectStore } from "../../src/storage/objects";

const databaseUrl = process.env.TEST_DATABASE_URL;

class MemoryObjects implements ObjectStore {
  readonly files = new Map<string, Buffer>();
  failNextDelete = false;

  async put(key: string, content: Buffer): Promise<void> {
    this.files.set(key, Buffer.from(content));
  }

  async get(key: string): Promise<Buffer> {
    const content = this.files.get(key);
    if (!content) throw new Error("Object not found");
    return Buffer.from(content);
  }

  async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("storage unavailable");
    }
    this.files.delete(key);
  }
}

describe.skipIf(!databaseUrl)("document deletion and retention", () => {
  const pool: Pool | undefined = databaseUrl
    ? createPool(databaseUrl)
    : undefined;
  const objects = new MemoryObjects();
  const embeddings = new LocalLexicalEmbeddings();

  function app(useObjects = true) {
    return createApp(pool!, {
      embeddings,
      answers: new LocalExtractiveAnswers(),
      limiter: { take: async () => true },
      answerLimiter: { take: async () => true },
      objects: useObjects ? objects : undefined,
    });
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
  });
  beforeEach(async () => {
    delete process.env.DOCUMENT_RETENTION_DAYS;
    await pool!.query(
      "TRUNCATE dead_letter_jobs, processed_events, document_chunks, outbox_events, processing_jobs, documents, sessions, workspace_memberships, workspaces, users CASCADE",
    );
    objects.files.clear();
    objects.failNextDelete = false;
  });
  afterEach(() => {
    delete process.env.DOCUMENT_RETENTION_DAYS;
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function setup(api = app()) {
    const owner = await request(api)
      .post("/auth/register")
      .send({
        email: `${randomUUID()}@example.com`,
        password: "long-password-123",
      })
      .expect(201);
    const member = await request(api)
      .post("/auth/register")
      .send({
        email: `${randomUUID()}@example.com`,
        password: "long-password-123",
      })
      .expect(201);
    const outsider = await request(api)
      .post("/auth/register")
      .send({
        email: `${randomUUID()}@example.com`,
        password: "long-password-123",
      })
      .expect(201);
    const workspace = await request(api)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Retention test" })
      .expect(201);
    const workspaceId = workspace.body.id as string;
    await pool!.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, member.body.userId],
    );
    return { api, owner, member, outsider, workspaceId };
  }

  async function upload(
    api: ReturnType<typeof app>,
    workspaceId: string,
    token: string,
    key = randomUUID(),
  ) {
    const response = await request(api)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", key)
      .auth(token, { type: "bearer" })
      .attach("file", Buffer.from("Private orchid evidence"), {
        filename: "evidence.txt",
        contentType: "text/plain",
      })
      .expect(202);
    return { ...response.body, key } as {
      documentId: string;
      jobId: string;
      key: string;
    };
  }

  async function finish(jobId: string) {
    const event = await pool!.query<{ payload: DocumentEvent }>(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [jobId],
    );
    await processDocumentEvent(
      pool!,
      event.rows[0]!.payload,
      1,
      embeddings,
      objects,
    );
  }

  it("hides a deleted source, invalidates answers, then erases bytes and vectors", async () => {
    const { api, owner, member, outsider, workspaceId } = await setup();
    const uploaded = await upload(api, workspaceId, owner.body.token);
    await finish(uploaded.jobId);
    const objectKey = `documents/${workspaceId}/${uploaded.key}`;
    const questionKey = randomUUID();
    const answer = await request(api)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", questionKey)
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What orchid evidence?" })
      .expect(200);
    expect(answer.body.citations[0].documentId).toBe(uploaded.documentId);

    const path = `/workspaces/${workspaceId}/documents/${uploaded.documentId}`;
    await request(api)
      .delete(path)
      .auth(outsider.body.token, { type: "bearer" })
      .expect(404);
    await request(api)
      .delete(path)
      .auth(member.body.token, { type: "bearer" })
      .expect(403);
    await request(api)
      .delete(path)
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    await request(api)
      .delete(path)
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    await request(api)
      .get(path)
      .auth(owner.body.token, { type: "bearer" })
      .expect(404);
    const hiddenChunks = await pool!.query(
      "SELECT count(*)::int AS count FROM document_chunks WHERE document_id = $1",
      [uploaded.documentId],
    );
    expect(hiddenChunks.rows[0].count).toBe(0);
    expect(objects.files.has(objectKey)).toBe(true);
    const replay = await request(api)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", questionKey)
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What orchid evidence?" })
      .expect(410);
    expect(replay.body.error).toBe("question_evidence_unavailable");
    await request(api)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", uploaded.key)
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Private orchid evidence"), {
        filename: "evidence.txt",
        contentType: "text/plain",
      })
      .expect(410);

    await pool!.query(
      "UPDATE document_deletions SET available_at = now() WHERE document_id = $1",
      [uploaded.documentId],
    );
    expect(await processDocumentDeletions(pool!, objects)).toEqual({
      completed: 1,
      failed: 0,
    });
    expect(objects.files.has(objectKey)).toBe(false);
    const rows = await pool!.query(
      `SELECT d.status, d.filename, d.content, d.storage_key, d.content_sha256,
              (SELECT count(*)::int FROM document_chunks WHERE document_id = d.id) AS chunks,
              (SELECT count(*)::int FROM usage_events WHERE workspace_id = d.workspace_id) AS usage
       FROM documents d WHERE d.id = $1`,
      [uploaded.documentId],
    );
    expect(rows.rows[0]).toMatchObject({
      status: "deleted",
      filename: "[deleted]",
      content: null,
      storage_key: null,
      content_sha256: null,
      chunks: 0,
    });
    expect(rows.rows[0].usage).toBeGreaterThan(0);
    await request(api)
      .delete(path)
      .auth(owner.body.token, { type: "bearer" })
      .expect(204);
    await request(api)
      .post(`/jobs/${uploaded.jobId}/retry`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(410);
  });

  it("waits for active processing and retries object deletion after an outage", async () => {
    const { api, owner, workspaceId } = await setup();
    const uploaded = await upload(api, workspaceId, owner.body.token);
    const path = `/workspaces/${workspaceId}/documents/${uploaded.documentId}`;
    await request(api)
      .delete(path)
      .auth(owner.body.token, { type: "bearer" })
      .expect(409);
    await finish(uploaded.jobId);
    await request(api)
      .delete(path)
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    await pool!.query(
      "UPDATE document_deletions SET available_at = now() WHERE document_id = $1",
      [uploaded.documentId],
    );
    objects.failNextDelete = true;
    expect(await processDocumentDeletions(pool!, objects)).toEqual({
      completed: 0,
      failed: 1,
    });
    const pending = await pool!.query(
      "SELECT attempts, last_error FROM document_deletions WHERE document_id = $1",
      [uploaded.documentId],
    );
    expect(pending.rows[0]).toMatchObject({
      attempts: 1,
      last_error: "storage unavailable",
    });
    await pool!.query(
      "UPDATE document_deletions SET available_at = now() WHERE document_id = $1",
      [uploaded.documentId],
    );
    expect(await processDocumentDeletions(pool!, objects)).toEqual({
      completed: 1,
      failed: 0,
    });
  });

  it("expires terminal documents while active jobs wait, including PostgreSQL bytes", async () => {
    process.env.DOCUMENT_RETENTION_DAYS = "1";
    const api = app(false);
    const { owner, workspaceId } = await setup(api);
    const uploaded = await upload(api, workspaceId, owner.body.token);
    const expiry = await pool!.query(
      "SELECT expires_at FROM documents WHERE id = $1",
      [uploaded.documentId],
    );
    expect(expiry.rows[0].expires_at).toBeTruthy();
    await pool!.query(
      "UPDATE documents SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [uploaded.documentId],
    );
    expect(await expireDocuments(pool!)).toBe(0);
    const event = await pool!.query<{ payload: DocumentEvent }>(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [uploaded.jobId],
    );
    await processDocumentEvent(pool!, event.rows[0]!.payload, 1, embeddings);
    expect(await expireDocuments(pool!)).toBe(1);
    expect(await processDocumentDeletions(pool!)).toEqual({
      completed: 1,
      failed: 0,
    });
    const row = await pool!.query(
      "SELECT status, content, filename FROM documents WHERE id = $1",
      [uploaded.documentId],
    );
    expect(row.rows[0]).toMatchObject({
      status: "deleted",
      content: null,
      filename: "[deleted]",
    });
  });

  it("rejects an in-flight answer whose cited document became unavailable", async () => {
    const { api, owner, workspaceId } = await setup();
    const uploaded = await upload(api, workspaceId, owner.body.token);
    await finish(uploaded.jobId);
    const questionKey = randomUUID();
    await reserveQuestion(
      pool!,
      workspaceId,
      owner.body.userId,
      questionKey,
      "a".repeat(64),
    );
    await request(api)
      .delete(`/workspaces/${workspaceId}/documents/${uploaded.documentId}`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await expect(
        completeQuestion(client, workspaceId, questionKey, {
          answer: "Private orchid evidence",
          citations: [{ documentId: uploaded.documentId }],
        }),
      ).rejects.toMatchObject({ status: 410 });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("records provider usage when deletion interrupts an in-flight answer", async () => {
    let startAnswer!: () => void;
    let finishAnswer!: () => void;
    const started = new Promise<void>((resolve) => {
      startAnswer = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finishAnswer = resolve;
    });
    const delayedAnswers: AnswerProvider = {
      model: "delayed-test",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
      async answer() {
        startAnswer();
        await released;
        return {
          answer: "Private orchid evidence",
          insufficientEvidence: false,
          citations: [1],
          inputTokens: 12,
          outputTokens: 3,
        };
      },
    };
    const api = createApp(pool!, {
      embeddings,
      answers: delayedAnswers,
      limiter: { take: async () => true },
      answerLimiter: { take: async () => true },
      objects,
    });
    const { owner, workspaceId } = await setup(api);
    const uploaded = await upload(api, workspaceId, owner.body.token);
    await finish(uploaded.jobId);
    const questionKey = randomUUID();
    const pendingAnswer = request(api)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", questionKey)
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What orchid evidence?" })
      .then((response) => response);
    await started;
    await request(api)
      .delete(`/workspaces/${workspaceId}/documents/${uploaded.documentId}`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(202);
    finishAnswer();
    expect((await pendingAnswer).status).toBe(410);
    const rows = await pool!.query(
      `SELECT u.input_tokens, u.output_tokens, q.status, q.response_body
       FROM usage_events u JOIN question_requests q ON q.workspace_id = u.workspace_id
       WHERE u.event_key = $1 AND q.idempotency_key = $2`,
      [`${questionKey}:answer`, questionKey],
    );
    expect(rows.rows[0]).toMatchObject({
      input_tokens: 12,
      output_tokens: 3,
      status: "uncertain",
      response_body: null,
    });
  });
});
