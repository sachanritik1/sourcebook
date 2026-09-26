/* global process, fetch, FormData, File, setTimeout, console */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const origin = process.env.WEB_PUBLIC_ORIGIN ?? "http://localhost:3001";
const suffix = randomUUID().slice(0, 8);

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
  "PASS upload replay, tenant isolation, job progress, failed-job retry, origin check",
);
