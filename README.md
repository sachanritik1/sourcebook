# Document research platform

An incremental, multi-tenant document research platform. **Current slice:** authentication, workspaces, a browser research desk with document uploads, job progress, grounded questions, citations, and usage; idempotent uploads and question replays; transactional outbox; workspace backlog control; BullMQ extraction and embedding; pgvector search; API and provider rate limits; operational metrics; retries; and dead-letter records.

## Local setup

Requirements: Docker Compose and Node.js 22 or newer.

```sh
docker compose up --build -d
curl http://localhost:3000/health/ready
```

Open [http://localhost:3001](http://localhost:3001) to create an account and workspace. Open a workspace to upload PDF/text files, watch jobs, retry failures, ask questions, inspect cited excerpts, and see approximate AI usage. The browser app stores the API session in an encrypted HttpOnly cookie. Compose includes a development-only cookie key; set `WEB_SESSION_KEY` to `openssl rand -hex 32` in `.env` before sharing an environment. For local web development, run `npm ci --prefix web && npm run dev --prefix web` with `API_BASE_URL=http://localhost:3000`, `WEB_PUBLIC_ORIGIN=http://localhost:3001`, and `WEB_SESSION_KEY` set.

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
  -H 'Idempotency-Key: <new-uuid-for-this-question>' \
  -d '{"question":"What does the document say about reliability?","topK":5}'
# Returns {"answer":"...","citations":[{"chunkId":"...","documentId":"...","filename":"...","ordinal":0,"excerpt":"..."}],"model":"..."}

curl http://localhost:3000/workspaces/<workspace-id>/usage \
  -H 'authorization: Bearer <token>'
```

`POST /auth/login` accepts the same credentials. `POST /auth/logout` revokes the bearer token. `GET /workspaces` lists only memberships for the caller. A nonmember receives 404 for workspace, document, and job IDs. Files are never served directly. Uploads accept one PDF or UTF-8 text file up to 5 MB per request. `GET /workspaces/:workspaceId/documents` lists document metadata. `GET /workspaces/:workspaceId/jobs?status=failed` lists failed jobs; `POST /jobs/:jobId/retry` retries one. Set `MAX_PROCESSING_ATTEMPTS` from 1 to 10 to change the retry budget for new jobs.

Generate a UUID `Idempotency-Key` for each intended upload. Reuse that key and the same file/filename when retrying after a lost response: the API returns `200` with the original IDs and current status. A reused key with different upload data returns `409`. A new key means a new upload, even for identical bytes.

Questions also require a UUID `Idempotency-Key`. Reuse the same key, question, and `topK` after a lost response: a completed request returns its saved answer without another provider call. `409 question_in_progress` means retry the same key shortly. `409 question_outcome_unknown` means the process may have died during a provider call; check usage before deliberately starting a new attempt with a new key. The same key with changed parameters returns `409 idempotency_key_reused`. Browser retries keep the key in session storage until an answer arrives.

The API accepts at most 20 queued or processing jobs per workspace by default (`MAX_PENDING_JOBS_PER_WORKSPACE`, 1–100). Upload, reindex, and manual retry return `429 workspace_job_limit` when full. A finished or failed job frees a slot. The worker still handles one active job per workspace; the cap bounds backlog but does not guarantee strict fairness in the shared queue.

Wait until the job is `completed` before searching. Search allows at most 10 queries per workspace per minute and `topK` from 1 to 10. Local Compose uses deterministic lexical vectors for key-free development; set `EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY` on both API and worker for semantic embeddings. The OpenAI adapter uses `text-embedding-3-small` with 1536 dimensions. Update the configurable token price as provider pricing changes. Existing completed documents can be indexed for a new model with `POST /workspaces/:workspaceId/documents/:documentId/reindex`; it returns a new job ID. Search only reads vectors for the active model.

Questions have a separate limit of three per workspace per minute. Local Compose returns a matching sentence from retrieved text, or abstains; it does not use an LLM. Set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` on the API for generated answers. The default LLM model is `gpt-4o-mini`; update `LLM_MODEL` and both token price variables together. The example prices reflect the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-4o-mini) at the time of this phase. Citations are validated against retrieved chunk IDs, but the application cannot automatically prove every claim is supported by the cited text.

The API allows 120 requests per client IP per minute by default (`API_REQUESTS_PER_MINUTE`); registration and login share a limit of 10 (`AUTH_REQUESTS_PER_MINUTE`). Health checks are excluded. General API limits allow requests through if Redis is down, preserving uploads; auth and AI limits return 503 until Redis recovers. Set `TRUST_PROXY_HOPS` only for the actual trusted proxies in front of the API. See ADR 0007 for this availability and security trade-off.

When using OpenAI, the API and worker share an embedding request budget of 60 calls per minute by default (`EMBEDDING_REQUESTS_PER_MINUTE`). Answer calls have a separate 30-per-minute budget (`ANSWER_REQUESTS_PER_MINUTE`). Set these below your provider account's limits. A full budget returns 503 with `Retry-After` on synchronous AI routes and delays worker jobs without consuming a processing failure attempt. The local adapters do not use these budgets. These counters limit requests, not tokens; provider limits can still be lower. See ADR 0009.
Temporary provider 429 responses count against the worker's retry budget and respect `Retry-After`; known credit, spend, and usage-limit errors fail immediately and appear in the dead-letter list. After fixing the provider account, use the existing manual job retry endpoint.

Set `METRICS_TOKEN` to a random secret of at least 32 characters to enable `GET /internal/metrics`. Send `Authorization: Bearer <metrics-token>`. The global snapshot includes BullMQ queue depth, pending outbox events, job status and end-to-end time, retry attempts for current job events, answer latency, and token totals. Keep this endpoint behind a private network in deployment. See ADR 0008 for metric definitions and limits.

## Architecture

```mermaid
flowchart LR
  Browser --> Web[Next.js research desk]
  Web --> API[Express API]
  CLI[API clients] --> API
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

PostgreSQL is the authority for identities, memberships, jobs, processed-event records, vectors, and usage. [ADR 0001](docs/adr/0001-workspace-boundary.md) records tenant isolation; [ADR 0002](docs/adr/0002-outbox-processing.md) explains delivery guarantees; [ADR 0003](docs/adr/0003-embeddings-and-search.md) explains vector checkpointing and search; [ADR 0004](docs/adr/0004-grounded-answers.md) explains citation validation and answer cost; [ADR 0005](docs/adr/0005-workspace-admission.md) explains workspace backlog limits; [ADR 0006](docs/adr/0006-upload-idempotency.md) explains upload retry safety; [ADR 0007](docs/adr/0007-api-rate-limits.md) explains edge limits and Redis outages; [ADR 0008](docs/adr/0008-operational-metrics.md) explains operational metrics; [ADR 0009](docs/adr/0009-provider-budget.md) explains provider capacity; [ADR 0010](docs/adr/0010-browser-session-boundary.md) explains the browser session boundary; [ADR 0011](docs/adr/0011-browser-upload-and-jobs.md) explains browser upload retries and job polling; [ADR 0012](docs/adr/0012-browser-research.md) explains visible evidence; [ADR 0013](docs/adr/0013-question-idempotency.md) explains replay and uncertain provider outcomes. Request, event, and job IDs appear in structured logs.

## Verification

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test -- tests/unit
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm run smoke --prefix web # requires the running Compose stack; creates test accounts and documents
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

For provider capacity, use a non-production provider key and set `EMBEDDING_REQUESTS_PER_MINUTE=1` on both API and worker. Upload two documents in one minute: the first embedding call uses the shared slot, while the second job waits until the next minute. A search in that minute returns 503 with `Retry-After`. Check that the waiting job has no dead-letter record and completes after the window resets. The automated test exercises the same behavior without an external API key.

For provider 429 handling, the integration tests inject a temporary 429 with `Retry-After` and a credit-exhaustion 429. Check that the temporary error keeps its bounded retry count, while credit exhaustion immediately sets the PostgreSQL job to `failed` and creates a dead-letter record. Replaying that event must leave it failed; only manual retry with a new event can resume it.

For the browser boundary, sign in and create a workspace at port 3001, then refresh: the session and workspace persist. Sign in as a second user in a private window: the first workspace must be absent. Tamper with the `sourcebook_session` cookie in browser dev tools and refresh: access should return 401. A cross-origin POST to `/api/workspaces` should return 403.

For browser upload recovery, select one text file, stop the web container while its request is in flight, then restart it and retry the draft in the same tab if it remains available. The API should return the same IDs when the first attempt committed. If the tab was closed, check the document list before selecting the file again: the browser no longer has the original key. Upload a file containing `%PDF-broken` as a PDF to see a failed job and its Retry action.

For browser research, wait until a document completes and ask a question using a phrase in that document. Confirm the answer lists the exact cited excerpt and that AI usage updates. Ask about an absent topic and check for an abstention without citations. Use a second account to request the first workspace's question or usage route; both return 404. Replay a completed question with the same key and inspect usage: the answer and totals stay unchanged. To simulate a crash after request reservation, stop the API during a slow provider call, restart it, and retry with the same key after two minutes. Expect `409 question_outcome_unknown`, then decide whether a new key and possible second charge are acceptable.
