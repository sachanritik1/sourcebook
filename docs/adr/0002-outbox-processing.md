# 0002: PostgreSQL outbox and at-least-once processing

## Decision

An upload stores a document row, a processing job, and an outbox event in one PostgreSQL transaction. The private file (maximum 5 MB) is staged separately in object storage first (ADR 0015); legacy files remain in PostgreSQL. The API returns `202` with the document and job IDs. A separate publisher leases outbox rows with `FOR UPDATE SKIP LOCKED`, adds BullMQ jobs with the outbox event ID as `jobId`, and marks rows published. The publisher periodically checks old queued or processing jobs and republishes events missing from Redis.

The worker extracts text and commits overlapping chunks, then checkpoints embedding batches. It commits completed job status and a `processed_events` row after all vectors are present. A PostgreSQL advisory lock allows one active document per workspace across worker processes. BullMQ runs four concurrent jobs per worker and retries processing failures up to three times by default. Ordinary failures use exponential backoff; temporary provider 429s honor `Retry-After` (ADR 0009). A permanently failed job enters a PostgreSQL dead-letter table; manual retry creates a new outbox event ID for the same logical job.

## Failure cases

| Failure point                                             | Recovery                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| API crashes before commit                                 | No document, job, or event appears.                                                                 |
| API commits then crashes before response                  | Work proceeds; retry with the same `Idempotency-Key` returns the original IDs (ADR 0006).           |
| Publisher crashes after enqueue, before marking published | Lease expires; it enqueues the same event ID again. BullMQ suppresses it while retained.            |
| Redis loses a published job                               | Reconciler finds the old PostgreSQL job and resets its outbox row for republishing.                 |
| Worker crashes before committing chunks                   | BullMQ retries; incomplete chunks are rolled back.                                                  |
| Worker commits then crashes before BullMQ acknowledgement | Replay sees `processed_events` and exits without duplicating chunks.                                |
| Processing fails three times                              | PostgreSQL job becomes failed and appears in `dead_letter_jobs`; an authorized member can retry it. |

## Trade-offs

This is at-least-once delivery with idempotent database effects, not exactly-once execution. BullMQ job IDs are a short-lived duplicate guard because jobs can be removed. PostgreSQL is the durable guard. An embedding provider call may be repeated if the worker crashes after the call and before storing its result; ADR 0003 records that cost-tracking limit.

New files use private S3-compatible storage with staging and cleanup (ADR 0015). PDF parsing runs in a bounded child process (ADR 0014). This protects the long-running worker from parser crashes and long-running calls, but the child is not an OS sandbox. The advisory lock limits one active job per workspace; a large tenant may still affect queue latency because BullMQ dispatches a shared queue. Fair scheduling can be added if observed latency requires it. See ADR 0003 for embedding checkpoints and provider-call failures.
