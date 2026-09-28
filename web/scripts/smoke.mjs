/* global process, fetch, FormData, File, Buffer, setTimeout, console */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const origin = process.env.WEB_PUBLIC_ORIGIN ?? "http://localhost:3001";
const suffix = randomUUID().slice(0, 8);

function samplePdf() {
  const stream = "BT /F1 18 Tf 72 720 Td (Reliable PDF extraction) Tj ET";
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

async function register(label) {
  const response = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      action: "register",
      email: `web-smoke-${label}-${suffix}@example.com`,
      password: "long-enough-smoke-password",
    }),
  });
  assert.equal(
    response.status,
    201,
    `register ${label}: ${await response.text()}`,
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function request(path, cookie, options = {}) {
  return fetch(`${origin}${path}`, {
    ...options,
    headers: { Cookie: cookie, Origin: origin, ...options.headers },
  });
}

async function upload(workspaceId, cookie, key, name, content, type) {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  return request(`/api/workspaces/${workspaceId}/documents`, cookie, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: form,
  });
}

async function waitForJob(workspaceId, cookie, jobId, wanted) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await request(
      `/api/workspaces/${workspaceId}/jobs`,
      cookie,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const job = body.jobs.find((item) => item.id === jobId);
    if (job?.status === wanted) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`job ${jobId} did not reach ${wanted}`);
}

const owner = await register("owner");
const other = await register("other");
const created = await request("/api/workspaces", owner, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `Smoke ${suffix}` }),
});
assert.equal(created.status, 201);
const workspace = await created.json();

const key = randomUUID();
const first = await upload(
  workspace.id,
  owner,
  key,
  "source.txt",
  "A short source note.",
  "text/plain",
);
if (first.status !== 202)
  throw new Error(`upload: ${first.status} ${await first.text()}`);
const firstBody = await first.json();
assert.match(first.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
const replay = await upload(
  workspace.id,
  owner,
  key,
  "source.txt",
  "A short source note.",
  "text/plain",
);
if (replay.status !== 200)
  throw new Error(`replay: ${replay.status} ${await replay.text()}`);
const replayBody = await replay.json();
assert.equal(replayBody.documentId, firstBody.documentId);
assert.equal(replayBody.jobId, firstBody.jobId);
const changed = await upload(
  workspace.id,
  owner,
  key,
  "source.txt",
  "A different source note.",
  "text/plain",
);
assert.equal(changed.status, 409);

const oversized = await upload(
  workspace.id,
  owner,
  randomUUID(),
  "large.txt",
  new Uint8Array(5 * 1024 * 1024 + 1),
  "text/plain",
);
assert.equal(oversized.status, 413);

const documents = await request(
  `/api/workspaces/${workspace.id}/documents`,
  owner,
);
assert.equal(documents.status, 200);
assert.equal(
  (await documents.json()).documents.filter(
    (item) => item.id === firstBody.documentId,
  ).length,
  1,
);
assert.equal(
  (await request(`/api/workspaces/${workspace.id}/documents`, other)).status,
  404,
);
await waitForJob(workspace.id, owner, firstBody.jobId, "completed");
const pdfUpload = await upload(
  workspace.id,
  owner,
  randomUUID(),
  "reliable.pdf",
  samplePdf(),
  "application/pdf",
);
if (pdfUpload.status !== 202)
  throw new Error(`PDF upload: ${pdfUpload.status} ${await pdfUpload.text()}`);
await waitForJob(
  workspace.id,
  owner,
  (await pdfUpload.json()).jobId,
  "completed",
);

async function ask(cookie, question, key = randomUUID()) {
  return request(`/api/workspaces/${workspace.id}/questions`, cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ question }),
  });
}
const answerKey = randomUUID();
const answered = await ask(owner, "What does the source note say?", answerKey);
if (answered.status !== 200)
  throw new Error(`question: ${answered.status} ${await answered.text()}`);
const grounded = await answered.json();
assert.match(grounded.answer, /source note/i);
assert.equal(grounded.citations.length, 1);
assert.equal(grounded.citations[0].filename, "source.txt");
assert.match(grounded.citations[0].excerpt, /source note/i);
const replayed = await ask(owner, "What does the source note say?", answerKey);
assert.equal(replayed.status, 200);
assert.deepEqual(await replayed.json(), grounded);
assert.equal((await ask(owner, "Another question", answerKey)).status, 409);
const absent = await ask(owner, "What about xylophone archaeology?");
assert.equal(absent.status, 200);
assert.deepEqual((await absent.json()).citations, []);
assert.equal((await ask(other, "What does the source note say?")).status, 404);
const usage = await request(`/api/workspaces/${workspace.id}/usage`, owner);
assert.equal(usage.status, 200);
assert.ok(
  (await usage.json()).usage.some((row) => row.operation === "llm_answer"),
);
assert.equal(
  (await request(`/api/workspaces/${workspace.id}/usage`, other)).status,
  404,
);
const crossOriginQuestion = await fetch(
  `${origin}/api/workspaces/${workspace.id}/questions`,
  {
    method: "POST",
    headers: {
      Cookie: owner,
      Origin: "https://other.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question: "What does the source note say?" }),
  },
);
assert.equal(crossOriginQuestion.status, 403);

const failedUpload = await upload(
  workspace.id,
  owner,
  randomUUID(),
  "broken.pdf",
  "%PDF-broken",
  "application/pdf",
);
if (failedUpload.status !== 202)
  throw new Error(
    `broken upload: ${failedUpload.status} ${await failedUpload.text()}`,
  );
const failedBody = await failedUpload.json();
await waitForJob(workspace.id, owner, failedBody.jobId, "failed");
const retry = await request(`/api/jobs/${failedBody.jobId}/retry`, owner, {
  method: "POST",
});
if (retry.status !== 202)
  throw new Error(`retry: ${retry.status} ${await retry.text()}`);
assert.equal((await retry.json()).jobId, failedBody.jobId);

const wrongOrigin = await fetch(
  `${origin}/api/jobs/${failedBody.jobId}/retry`,
  {
    method: "POST",
    headers: { Cookie: owner, Origin: "https://other.example" },
  },
);
assert.equal(wrongOrigin.status, 403);

console.log(
  "PASS upload and answer replay, PDF extraction, tenant isolation, usage, job retry, origin check",
);
