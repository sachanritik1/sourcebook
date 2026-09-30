# 0015: Private object storage with staged uploads

## Decision

New uploads use a private S3-compatible bucket; Compose runs S3Mock inside its network. Express still accepts at most 5 MB and validates membership, filename, media type, and text encoding. PostgreSQL first reserves `(workspace_id, idempotency_key, fingerprint, object_key)` under the workspace admission lock. The API PUTs bytes at that stable key, then commits the document pointer and SHA-256, processing job, outbox event, and final idempotency record in one PostgreSQL transaction. The worker fetches the object and verifies the SHA-256 before extraction. Legacy documents with `content` in PostgreSQL remain readable.

The API returns `202` only after object PUT and database commit. A finished upload replay returns its original IDs without another PUT. A conflicting fingerprint cannot overwrite staged bytes. Two matching concurrent requests may PUT the same bytes twice, but the admission lock gives them one document and outbox event. The staging table caps outstanding reservations per workspace in addition to the job backlog cap.

## Failure and recovery

| Failure                                    | Recovery                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Reservation commits, PUT fails             | Return 503; same-key retry uses the reservation. No job exists yet.                                                            |
| PUT succeeds, API dies before final commit | Same-key retry PUTs identical bytes and finalizes. A 24-hour cleanup pass deletes abandoned objects if no final record exists. |
| Final commit succeeds, response is lost    | Same-key retry returns the original IDs without PUT.                                                                           |
| Storage fails during worker read           | BullMQ retries, then marks the job failed; manual retry can resume after storage recovers.                                     |
| Object bytes change unexpectedly           | SHA-256 mismatch fails processing before extraction.                                                                           |
| Cleanup delete fails                       | Reservation remains `deleting`; a later cleanup pass retries deletion.                                                         |

The cleanup process locks one old reservation, checks the final idempotency record, and marks unfinalized reservations `deleting` before the network delete. It releases the database connection during that call. A finalized object is never deleted by this pass. A request that arrives after its reservation has entered `deleting` should retry after cleanup or use a fresh key; the original key can be reused once deletion finishes.

## Trade-offs

S3 and PostgreSQL cannot share a transaction. The reservation, stable key, checksum, and compensating cleanup give a recoverable at-least-once workflow, not atomic cross-system commit. The 24-hour cleanup window allows ordinary retries but temporarily retains abandoned bytes. The publisher runs cleanup alongside outbox polling for this local scale; it can move to a dedicated process if deletion volume grows. An S3 lifecycle rule can backstop abandoned-object cleanup in AWS, but it must not delete finalized documents.

Server-mediated upload keeps the existing browser and API contract simple at 5 MB. It uses API memory and an extra network hop; large uploads should use short-lived signed URLs plus explicit finalization. S3Mock is only a local API emulator. AWS deployment will require a private bucket, IAM permissions, encryption and lifecycle policy, and object retention rules. No public object URLs are issued. ADR 0016 covers document deletion; workspace deletion remains a separate lifecycle decision.
