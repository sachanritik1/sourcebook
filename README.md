# Document research platform

An incremental, multi-tenant document research platform. **Phase 1:** authentication, workspace ownership, tenant-scoped reads, migrations, and a local Express API. Document uploads, asynchronous processing, and RAG come in later phases.

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
```

`POST /auth/login` accepts the same credentials. `POST /auth/logout` revokes the bearer token. `GET /workspaces` lists only memberships for the caller. A nonmember receives 404 for a workspace ID.

## Architecture

```mermaid
flowchart LR
  Client --> API[Express API]
  API --> PG[(PostgreSQL)]
  API -. next phase .-> Outbox[(Transactional outbox)]
  Outbox -. publisher .-> Redis[(Redis / BullMQ)]
  Redis -. jobs .-> Worker[Workers]
```

PostgreSQL is the authority for identities and memberships. Redis is provisioned for a later processing phase but unused by this API. [ADR 0001](docs/adr/0001-workspace-boundary.md) records the tenant isolation decision. Request IDs appear in the `x-request-id` response header and structured logs.

## Verification

```sh
npm run typecheck
npm run lint
npm run format:check
docker compose exec postgres createdb -U app research_test
TEST_DATABASE_URL=postgres://app:app@localhost:5433/research_test npm run test:integration
```

The integration test clears identity tables in its target database. Use a dedicated test database.
