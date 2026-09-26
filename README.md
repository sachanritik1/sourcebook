# Document research platform

An incremental, multi-tenant document research platform. **Current slice:** authentication, workspaces, private PDF/text uploads with idempotent retries, transactional outbox, workspace backlog control, BullMQ extraction and embedding, pgvector search, grounded answers with citations, API rate limits, operational metrics, job progress, retries, dead-letter records, and approximate token usage. A frontend is a later slice.

## Local setup

Requirements: Docker Compose and Node.js 22 or newer.

```sh
docker compose up --build -d
curl http://localhost:3000/health/ready
```

For local API development, run `docker compose up -d postgres redis`, copy `.env.example` to `.env`, then `npm ci && npm run migrate && npm run dev`.

## API example

```sh
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"replace-with-a-long-password"}'
# Response includes token. Keep it private.

curl -X POST http://localhost:3000/workspaces \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"name":"Acme Research"}'

curl http://localhost:3000/workspaces/<workspace-id> \
  -H 'authorization: Bearer <token>'

curl -X POST http://localhost:3000/workspaces/<workspace-id>/documents \
  -H 'authorization: Bearer <token>' \
  -H 'Idempotency-Key: <new-uuid-for-this-upload>' \
  -F 'file=@notes.pdf;type=application/pdf'
# Returns 202: {"documentId":"...","jobId":"...","status":"queued"}

curl http://localhost:3000/jobs/<job-id> \
  -H 'authorization: Bearer <token>'

curl -X POST http://localhost:3000/workspaces/<workspace-id>/search \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"query":"What does the document say about reliability?","topK":5}'
# Returns chunks with chunkId, documentId, filename, ordinal, content, score.

curl -X POST http://localhost:3000/workspaces/<workspace-id>/questions \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"question":"What does the document say about reliability?","topK":5}'
# Returns {"answer":"...","citations":[{"chunkId":"...","documentId":"...","filename":"...","ordinal":0}],"model":"..."}

curl http://localhost:3000/workspaces/<workspace-id>/usage \
  -H 'authorization: Bearer <token>'
```

`POST /auth/login` accepts the same credentials. `POST /auth/logout` revokes the bearer token. `GET /workspaces` lists only memberships for the caller. A nonmember receives 404 for workspace, document, and job IDs. Files are never served directly. Uploads accept one PDF or UTF-8 text file up to 5 MB per request. `GET /workspaces/:workspaceId/documents` lists document metadata. `GET /workspaces/:workspaceId/jobs?status=failed` lists failed jobs; `POST /jobs/:jobId/retry` retries one. Set `MAX_PROCESSING_ATTEMPTS` from 1 to 10 to change the retry budget for new jobs.

Generate a UUID `Idempotency-Key` for each intended upload. Reuse that key and the same file/filename when retrying after a lost response: the API returns `200` with the original IDs and current status. A reused key with different upload data returns `409`. A new key means a new upload, even for identical bytes.

The API accepts at most 20 queued or processing jobs per workspace by default (`MAX_PENDING_JOBS_PER_WORKSPACE`, 1–100). Upload, reindex, and manual retry return `429 workspace_job_limit` when full. A finished or failed job frees a slot. The worker still handles one active job per workspace; the cap bounds backlog but does not guarantee strict fairness in the shared queue.

Wait until the job is `completed` before searching. Search allows at most 10 queries per workspace per minute and `topK` from 1 to 10. Local Compose uses deterministic lexical vectors for key-free development; set `EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY` on both API and worker for semantic embeddings. The OpenAI adapter uses `text-embedding-3-small` with 1536 dimensions. Update the configurable token price as provider pricing changes. Existing completed documents can be indexed for a new model with `POST /workspaces/:workspaceId/documents/:documentId/reindex`; it returns a new job ID. Search only reads vectors for the active model.

Questions have a separate limit of three per workspace per minute. Local Compose returns a matching sentence from retrieved text, or abstains; it does not use an LLM. Set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` on the API for generated answers. The default LLM model is `gpt-4o-mini`; update `LLM_MODEL` and both token price variables together. The example prices reflect the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-4o-mini) at the time of this phase. Citations are validated against retrieved chunk IDs, but the application cannot automatically prove every claim is supported by the cited text.

The API allows 120 requests per client IP per minute by default (`API_REQUESTS_PER_MINUTE`); registration and login share a limit of 10 (`AUTH_REQUESTS_PER_MINUTE`). Health checks are excluded. General API limits allow requests through if Redis is down, preserving uploads; auth and AI limits return 503 until Redis recovers. Set `TRUST_PROXY_HOPS` only for the actual trusted proxies in front of the API. See ADR 0007 for this availability and security trade-off.

Set `METRICS_TOKEN` to a random secret of at least 32 characters to enable `GET /internal/metrics`. Send `Authorization: Bearer <metrics-token>`. The global snapshot includes BullMQ queue depth, pending outbox events, job status and end-to-end time, retry attempts for current job events, answer latency, and token totals. Keep this endpoint behind a private network in deployment. See ADR 0008 for metric definitions and limits.

## Architecture

```mermaid
flowchart LR
  Client --> API[Express API]
  API --> PG[(PostgreSQL)]
  API --> Outbox[(Transactional outbox)]
  Outbox --> Publisher
  Publisher --> Redis[(Redis / BullMQ)]
  Redis --> Worker[Extraction and embedding worker]
  Worker --> PG
  API --> Vector[pgvector exact search]
  Vector --> PG
  API --> LLM[Answer provider]
```

PostgreSQL is the authority for identities, memberships, jobs, processed-event records, vectors, and usage. [ADR 0001](docs/adr/0001-workspace-boundary.md) records tenant isolation; [ADR 0002](docs/adr/0002-outbox-processing.md) explains delivery guarantees; [ADR 0003](docs/adr/0003-embeddings-and-search.md) explains vector checkpointing and search; [ADR 0004](docs/adr/0004-grounded-answers.md) explains citation validation and answer cost; [ADR 0005](docs/adr/0005-workspace-admission.md) explains workspace backlog limits; [ADR 0006](docs/adr/0006-upload-idempotency.md) explains upload retry safety; [ADR 0007](docs/adr/0007-api-rate-limits.md) explains edge limits and Redis outages; [ADR 0008](docs/adr/0008-operational-metrics.md) explains operational metrics. Request, event, and job IDs appear in structured logs.

## Verification

```sh
npm run typecheck
npm run lint
npm run format:check
docker compose exec postgres createdb -U app research_test
TEST_DATABASE_URL=postgres://app:app@localhost:5433/research_test \
  TEST_REDIS_URL=redis://localhost:6380 npm run test:integration
```

The integration tests clear application tables in their target database. Use a dedicated test database for them.

## Failure experiment

Upload a file containing `%PDF-broken` as `application/pdf`. Poll its job: it moves through retries to `failed`, then appears in the failed-job list. Call `POST /jobs/:jobId/retry` and observe a new event for the same job. Also try the upload while Redis is stopped: the API still returns a queued job because the outbox is in PostgreSQL; publishing resumes when Redis returns.

For embedding recovery, interrupt a worker after one batch is saved, restart it, and observe that stored vectors are skipped. If the provider completed a request but the worker died before the batch commit, the external request may repeat; the usage endpoint counts committed batches, so it is an estimate.

For answer behavior, ask about a topic absent from all indexed documents. The local provider should abstain; the OpenAI provider is instructed to abstain when excerpts lack support. Ask as a nonmember and verify a 404 before any provider call. The automated test also injects a citation outside the retrieved set and verifies rejection.

For admission control, set `MAX_PENDING_JOBS_PER_WORKSPACE=1` and restart the API. Stop the worker, then upload two files to the same workspace: the first returns 202 and the second returns 429. Upload to another workspace to see its independent slot. Restart the worker; after the first job completes, the second upload can be retried.

For HTTP retry safety, upload once with a UUID `Idempotency-Key` and repeat the same request with that key. The second response is 200 with the same IDs and no new outbox event. Change the file while keeping the key to see 409. Use a new key for a deliberately separate upload.

For rate limiting, set `API_REQUESTS_PER_MINUTE=2`, restart the API, and call `GET /workspaces` three times without a token: expect 401, 401, then 429 with `Retry-After`. `/health/live` remains available. With an existing bearer token, stop Redis and try an upload: the API can still create the PostgreSQL job and outbox event; registration and AI endpoints return 503 until Redis restarts.

For metrics, set `METRICS_TOKEN` and restart the API. Upload and process a document, then call `GET /internal/metrics` with the token. Without the token, expect 401. Stop Redis and repeat with the token: the snapshot fails because queue depth cannot be read; `/health/ready` still checks PostgreSQL only.
