import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../../src/app";
import { LocalLexicalEmbeddings } from "../../src/ai/embeddings";
import { LocalExtractiveAnswers } from "../../src/ai/answers";
import { migrate } from "../../src/db/migrate";
import { createPool } from "../../src/db/pool";
import { processDocumentEvent } from "../../src/processing/processor";
import {
  cleanupStagedUploads,
  reserveStagedUpload,
} from "../../src/storage/staging";
import type { ObjectStore } from "../../src/storage/objects";
import type { DocumentEvent } from "../../src/processing/types";

const databaseUrl = process.env.TEST_DATABASE_URL;

class MemoryObjects implements ObjectStore {
  readonly files = new Map<string, Buffer>();
  puts = 0;
  failNextPut = false;
  failNextDelete = false;

  async put(key: string, content: Buffer): Promise<void> {
    this.puts++;
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("object store unavailable");
    }
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
      throw new Error("object deletion unavailable");
    }
    this.files.delete(key);
  }
}

describe.skipIf(!databaseUrl)("private object storage", () => {
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  const objects = new MemoryObjects();
  const embeddings = new LocalLexicalEmbeddings();
  const app = pool
    ? createApp(pool, {
        embeddings,
        limiter: { take: async () => true },
        answers: new LocalExtractiveAnswers(),
        answerLimiter: { take: async () => true },
        objects,
      })
    : null;

  beforeAll(async () => {
    await migrate(databaseUrl!);
  });
  beforeEach(async () => {
    await pool!.query(
      "TRUNCATE dead_letter_jobs, processed_events, document_chunks, outbox_events, processing_jobs, documents, sessions, workspace_memberships, workspaces, users CASCADE",
    );
    objects.files.clear();
    objects.puts = 0;
    objects.failNextPut = false;
    objects.failNextDelete = false;
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function setup() {
    const owner = await request(app!)
      .post("/auth/register")
      .send({
        email: `${randomUUID()}@example.com`,
        password: "long-password-123",
      })
      .expect(201);
    const outsider = await request(app!)
      .post("/auth/register")
      .send({
        email: `${randomUUID()}@example.com`,
        password: "long-password-123",
      })
      .expect(201);
    const workspace = await request(app!)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Private objects" })
      .expect(201);
    return { owner, outsider, workspaceId: workspace.body.id as string };
  }

  function upload(
    workspaceId: string,
    token: string,
    key: string,
    content: string,
  ) {
    return request(app!)
      .post(`/workspaces/${workspaceId}/documents`)
      .set("Idempotency-Key", key)
      .auth(token, { type: "bearer" })
      .attach("file", Buffer.from(content), {
        filename: "note.txt",
        contentType: "text/plain",
      });
  }

  it("stores new bytes privately and indexes the verified object", async () => {
    const { owner, outsider, workspaceId } = await setup();
    const key = randomUUID();
    const created = await upload(
      workspaceId,
      owner.body.token,
      key,
      "Private orchid evidence",
    ).expect(202);
    const row = await pool!.query<{
      content: Buffer | null;
      storage_key: string;
      content_sha256: string;
    }>(
      "SELECT content, storage_key, content_sha256 FROM documents WHERE id = $1",
      [created.body.documentId],
    );
    expect(row.rows[0]?.content).toBeNull();
    expect(row.rows[0]?.storage_key).toBe(`documents/${workspaceId}/${key}`);
    expect(objects.files.get(row.rows[0]!.storage_key)?.toString()).toBe(
      "Private orchid evidence",
    );
    const event = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [created.body.jobId],
    );
    await processDocumentEvent(
      pool!,
      event.rows[0].payload as DocumentEvent,
      1,
      embeddings,
      objects,
    );
    const replay = await upload(
      workspaceId,
      owner.body.token,
      key,
      "Private orchid evidence",
    ).expect(200);
    expect(replay.body.jobId).toBe(created.body.jobId);
    expect(objects.puts).toBe(1);
    await upload(
      workspaceId,
      outsider.body.token,
      key,
      "Private orchid evidence",
    ).expect(404);
    const answer = await request(app!)
      .post(`/workspaces/${workspaceId}/questions`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What orchid evidence?" })
      .expect(200);
    expect(answer.body.answer).toContain("Private orchid evidence");
  });

  it("rejects a conflicting key before it can overwrite staged bytes", async () => {
    const { owner, workspaceId } = await setup();
    const key = randomUUID();
    objects.failNextPut = true;
    const failed = await upload(
      workspaceId,
      owner.body.token,
      key,
      "Original bytes",
    ).expect(503);
    expect(failed.body.error).toBe("object_storage_unavailable");
    await upload(workspaceId, owner.body.token, key, "Different bytes").expect(
      409,
    );
    expect(objects.puts).toBe(1);
    const retried = await upload(
      workspaceId,
      owner.body.token,
      key,
      "Original bytes",
    ).expect(202);
    expect(retried.body.jobId).toBeTruthy();
    expect(objects.puts).toBe(2);
  });

  it("commits one upload when matching requests arrive concurrently", async () => {
    const { owner, workspaceId } = await setup();
    const key = randomUUID();
    const responses = await Promise.all([
      upload(workspaceId, owner.body.token, key, "Concurrent evidence"),
      upload(workspaceId, owner.body.token, key, "Concurrent evidence"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 202,
    ]);
    expect(responses[0].body.jobId).toBe(responses[1].body.jobId);
    const rows = await pool!.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(rows.rows[0].count).toBe(1);
  });

  it("recovers a staged object after a lost finalization and cleans abandoned ones", async () => {
    const { owner, workspaceId } = await setup();
    const content = Buffer.from("Recover staged bytes");
    const key = randomUUID();
    const fingerprint = createHash("sha256")
      .update("note.txt\0text/plain\0")
      .update(content)
      .digest("hex");
    const objectKey = await reserveStagedUpload(
      pool!,
      workspaceId,
      owner.body.userId,
      key,
      fingerprint,
      20,
    );
    await objects.put(objectKey, content, "text/plain");
    const recovered = await upload(
      workspaceId,
      owner.body.token,
      key,
      content.toString(),
    ).expect(202);
    expect(recovered.body.jobId).toBeTruthy();

    const abandonedKey = randomUUID();
    const abandonedObject = await reserveStagedUpload(
      pool!,
      workspaceId,
      owner.body.userId,
      abandonedKey,
      fingerprint,
      20,
    );
    await objects.put(abandonedObject, content, "text/plain");
    await pool!.query(
      "UPDATE upload_staging SET created_at = now() - interval '25 hours' WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(await cleanupStagedUploads(pool!, objects)).toBe(2);
    expect(objects.files.has(abandonedObject)).toBe(false);
    expect(objects.files.has(objectKey)).toBe(true);
    const final = await pool!.query(
      "SELECT count(*)::int AS count FROM documents WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(final.rows[0].count).toBe(1);
  });

  it("refuses to index an object with a changed checksum", async () => {
    const { owner, workspaceId } = await setup();
    const uploaded = await upload(
      workspaceId,
      owner.body.token,
      randomUUID(),
      "Original evidence",
    ).expect(202);
    const row = await pool!.query(
      "SELECT storage_key FROM documents WHERE id = $1",
      [uploaded.body.documentId],
    );
    objects.files.set(
      row.rows[0].storage_key,
      Buffer.from("Tampered evidence"),
    );
    const event = await pool!.query(
      "SELECT payload FROM outbox_events WHERE job_id = $1",
      [uploaded.body.jobId],
    );
    await expect(
      processDocumentEvent(
        pool!,
        event.rows[0].payload as DocumentEvent,
        1,
        embeddings,
        objects,
      ),
    ).rejects.toThrow("Stored document checksum mismatch");
  });

  it("retries abandoned-object deletion after a storage outage", async () => {
    const { owner, workspaceId } = await setup();
    const key = randomUUID();
    const fingerprint = createHash("sha256").update("abandoned").digest("hex");
    const objectKey = await reserveStagedUpload(
      pool!,
      workspaceId,
      owner.body.userId,
      key,
      fingerprint,
      20,
    );
    await objects.put(objectKey, Buffer.from("abandoned"), "text/plain");
    await pool!.query(
      "UPDATE upload_staging SET created_at = now() - interval '25 hours' WHERE workspace_id = $1",
      [workspaceId],
    );
    objects.failNextDelete = true;
    await expect(cleanupStagedUploads(pool!, objects)).rejects.toThrow(
      "object deletion unavailable",
    );
    const pending = await pool!.query(
      "SELECT status FROM upload_staging WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, key],
    );
    expect(pending.rows[0].status).toBe("deleting");
    expect(await cleanupStagedUploads(pool!, objects)).toBe(1);
    expect(objects.files.has(objectKey)).toBe(false);
  });
});
