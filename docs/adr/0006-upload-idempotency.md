# 0006: Client operation keys for safe upload retries

## Decision

`POST /workspaces/:workspaceId/documents` requires an `Idempotency-Key` UUID. The client creates one key per intended upload and reuses it only when retrying that upload. Inside the document/job/outbox transaction, the API stores `(workspace_id, idempotency_key, request_fingerprint, document_id, job_id)` in `upload_idempotency`. The fingerprint covers the normalized filename, validated media type, and file bytes. Its primary key is the durable duplicate guard.

The API checks finalized keys before object storage work. For a new object-backed upload, it reserves the key and fingerprint under the workspace admission lock before PUT (ADR 0015). Finalization takes the same lock, rechecks the key, then tests backlog capacity. A replay with the same fingerprint returns `200` with the original document and job IDs plus the job's current status. A different upload with the same key returns `409 idempotency_key_reused`. First submission still returns `202 queued`. A nonmember gets `404` before the key is inspected.

## Why and failure cases

An outbox event ID identifies a _single committed event_. It deduplicates event delivery, but a second HTTP `POST` used to create an entirely new document, job, and event. A content hash alone would prevent a user from intentionally uploading the same file twice. The client operation key distinguishes a retry from a second upload; the fingerprint detects accidental key reuse.

| Failure or race                                    | Result                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| API crashes before final commit                    | No document, job, or event exists; a staged reservation/object may remain (ADR 0015).  |
| API commits then response is lost                  | Retry returns the original IDs, even if processing has completed.                      |
| Two identical requests arrive together             | Workspace admission lock serializes them; one creates records, the other replays them. |
| Workspace backlog is full during replay            | Replay still returns original IDs because lookup precedes the capacity check.          |
| Same key is reused for different bytes or metadata | 409; no new document, job, or outbox event.                                            |

Keys are scoped to a workspace and retained with its document. This is durable retry safety rather than a short TTL cache. Document deletion would cascade the key record; a future delete API must document that retention boundary. Clients that lose their key cannot request the exact replay and should list documents before starting a new upload. The API returns the current job status rather than the original response body so callers can resume polling directly.
