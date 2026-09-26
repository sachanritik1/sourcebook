# Document research platform

An incremental, multi-tenant document research platform. **Current slice:** authentication, workspaces, private PDF/text uploads, transactional outbox, BullMQ extraction and embedding, pgvector search, job progress, retries, dead-letter records, and approximate embedding usage. Answer generation and a frontend are later slices.

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
  -F 'file=@notes.pdf;type=application/pdf'
# Returns 202: {"documentId":"...","jobId":"...","status":"queued"}

curl http://localhost:3000/jobs/<job-id> \
  -H 'authorization: Bearer <token>'

curl -X POST http://localhost:3000/workspaces/<workspace-id>/search \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"query":"What does the document say about reliability?","topK":5}'
# Returns chunks with chunkId, documentId, filename, ordinal, content, score.

curl http://localhost:3000/workspaces/<workspace-id>/usage \
  -H 'authorization: Bearer <token>'
```

`POST /auth/login` accepts the same credentials. `POST /auth/logout` revokes the bearer token. `GET /workspaces` lists only memberships for the caller. A nonmember receives 404 for workspace, document, and job IDs. Files are never served directly. Uploads accept one PDF or UTF-8 text file up to 5 MB per request. `GET /workspaces/:workspaceId/documents` lists document metadata. `GET /workspaces/:workspaceId/jobs?status=failed` lists failed jobs; `POST /jobs/:jobId/retry` retries one. Set `MAX_PROCESSING_ATTEMPTS` from 1 to 10 to change the retry budget for new jobs.

Wait until the job is `completed` before searching. Search allows at most 10 queries per workspace per minute and `topK` from 1 to 10. Local Compose uses deterministic lexical vectors for key-free development; set `EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY` on both API and worker for semantic embeddings. The OpenAI adapter uses `text-embedding-3-small` with 1536 dimensions. Update the configurable token price as provider pricing changes. Existing completed documents can be indexed for a new model with `POST /workspaces/:workspaceId/documents/:documentId/reindex`; it returns a new job ID. Search only reads vectors for the active model.

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
```

PostgreSQL is the authority for identities, memberships, jobs, processed-event records, vectors, and usage. [ADR 0001](docs/adr/0001-workspace-boundary.md) records tenant isolation; [ADR 0002](docs/adr/0002-outbox-processing.md) explains delivery guarantees; [ADR 0003](docs/adr/0003-embeddings-and-search.md) explains vector checkpointing and search. Request, event, and job IDs appear in structured logs.

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
