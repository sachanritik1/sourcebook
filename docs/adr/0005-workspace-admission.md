# 0005: Bound each workspace's processing backlog

## Decision

The API allows at most `MAX_PENDING_JOBS_PER_WORKSPACE` queued or processing jobs per workspace (default 20, configurable from 1 to 100). Upload, reindex, and manual retry all check this limit inside the PostgreSQL transaction that writes the job and outbox event. They take the same workspace-specific transaction advisory lock before counting. If the workspace is full, the transaction rolls back and the API returns `429 workspace_job_limit`. A completed or permanently failed job frees a slot.

The admission lock uses a different hash seed from the worker's session lock. It serializes only job creation decisions for one workspace; it does not hold a lock during processing. The worker still runs at most one document per workspace. This simple PostgreSQL check is appropriate while the upload path already writes there and the cap is small.

## Why and limits

Counting without a lock would race: two concurrent uploads could both see 19 of 20 jobs and both insert. The lock makes the count-and-write decision serial. The job and its outbox event still commit together, including when Redis is unavailable.

The cap bounds a tenant's queued work, but BullMQ's shared queue still has no strict fair scheduling. Twenty jobs from one workspace can appear before another workspace's job. A per-tenant fair dispatcher or tenant queues would be justified if queue-wait metrics show a problem. A queue order change is not needed just to enforce this initial cap.

An upload that commits before the HTTP response is lost can be retried by the client as a distinct document and consume another slot. Client-supplied upload idempotency keys remain a separate improvement. The limit is an admission control, not a storage quota; completed documents remain stored.
