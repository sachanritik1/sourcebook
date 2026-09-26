# 0001: Start with an explicit workspace boundary

## Decision

Use an Express API with PostgreSQL repositories written as parameterized SQL. A user has a workspace membership; every tenant-owned row added later must include `workspace_id`. Every tenant route must filter by both workspace ID and authenticated membership. An opaque session token is stored only as a SHA-256 hash and expires after seven days.

## Why

This makes the authorization predicate visible in code and integration tests. It avoids an ORM or framework hiding the query that decides tenant access. Opaque sessions can be revoked immediately without token blacklists.

## Trade-offs and follow-up

Each authenticated request reads PostgreSQL. That is acceptable initially and keeps revocation simple. A short TTL cache may be considered if session reads become measurable load. PostgreSQL row-level security would provide another guard, but requires disciplined per-request connection context; add it only after the application access rules are stable. Future document, job, outbox, chunk, and usage tables need explicit workspace IDs and composite tenant-aware foreign keys where a child references another tenant row.
