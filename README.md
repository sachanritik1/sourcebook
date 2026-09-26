# Document research platform

An incremental, multi-tenant document research platform. **Current slice:** authentication, workspace ownership, private PDF/text upload, transactional outbox, BullMQ extraction worker, job progress, retries, and dead-letter records. Embeddings, retrieval, answers, usage tracking, and a frontend are later slices.

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
```

`POST /auth/login` accepts the same credentials. `POST /auth/logout` revokes the bearer token. `GET /workspaces` lists only memberships for the caller. A nonmember receives 404 for workspace, document, and job IDs. Files are never served directly. Uploads accept one PDF or UTF-8 text file up to 5 MB per request. `GET /workspaces/:workspaceId/documents` lists document metadata. `GET /workspaces/:workspaceId/jobs?status=failed` lists failed jobs; `POST /jobs/:jobId/retry` retries one. Set `MAX_PROCESSING_ATTEMPTS` from 1 to 10 to change the retry budget for new jobs.

## Architecture

```mermaid
flowchart LR
  Client --> API[Express API]
  API --> PG[(PostgreSQL)]
  API --> Outbox[(Transactional outbox)]
  Outbox --> Publisher
  Publisher --> Redis[(Redis / BullMQ)]
  Redis --> Worker[Extraction worker]
  Worker --> PG
```

PostgreSQL is the authority for identities, memberships, jobs, and processed-event records. [ADR 0001](docs/adr/0001-workspace-boundary.md) records tenant isolation; [ADR 0002](docs/adr/0002-outbox-processing.md) explains delivery guarantees and crash recovery. Request, event, and job IDs appear in structured logs.

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
