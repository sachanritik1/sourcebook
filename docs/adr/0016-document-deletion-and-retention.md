# 0016: Document deletion and optional expiry

## Decision

Only workspace owners can delete a completed or failed document. The API transaction marks it `deleting`, invalidates saved answers citing it, removes chunks and vectors, blocks new upload replays, and creates a durable `document_deletions` task. Lists, search, question replay, and job routes exclude deleting or expired documents immediately. A publisher pass claims deletion tasks with a 45-second lease, deletes the private object, then redacts the document row. Failed object deletes back off exponentially and retry without a permanent failure cutoff. The operational metrics endpoint reports pending deletions, retries, and oldest age.

The row remains as a minimal tombstone: ID, workspace, timestamps, redacted filename, job and upload-key history. This preserves idempotency and approximate usage while erasing source bytes and indexed text. Completed question requests citing the document become response-free `invalidated` tombstones, so their keys cannot replay deleted excerpts or buy another provider call. An in-flight answer checks its cited documents before saving; if deletion won the race, it records provider usage and returns 410 without saving the answer.

`DOCUMENT_RETENTION_DAYS=0` disables automatic expiry. A positive value (1–3650 days) sets `expires_at` on new uploads; changing it does not rewrite existing rows. Reads stop serving an expired document at its deadline. The publisher schedules deletion once its job is completed or failed. Active jobs are allowed to finish and then expire. Legacy PostgreSQL bytea documents use the same redaction path without an object delete.

## Failure cases

| Failure                                         | Recovery                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| API crashes before deletion transaction commits | Document remains available; owner retries.                               |
| API commits, response is lost                   | Repeat DELETE returns 202 while pending, then 204 after cleanup.         |
| Object delete fails                             | Task remains with error and next attempt; content stays hidden.          |
| Object delete succeeds, DB finalization fails   | Lease expires; idempotent object delete repeats, then redaction commits. |
| Publisher stops                                 | Durable task remains in PostgreSQL; restart resumes cleanup.             |
| Answer provider finishes during deletion        | Citation check rejects the response; provider usage remains recorded.    |

## Trade-offs

Deletion is limited to terminal jobs. Cancellation of an active extraction or provider call would need its own coordination path. A two-minute delay before object deletion covers already-admitted PUTs, whose SDK call has a 30-second timeout; deleting status blocks new replays. This keeps network I/O outside database transactions. Object bytes, chunks, and saved cited excerpts are removed, while minimal tombstones and usage history remain. PostgreSQL and object-store backups may retain older copies until their separate retention windows expire. Workspace deletion and retention of uncited question answers need separate policies before a public production launch.
