# 0013: Question replay and provider uncertainty

## Decision

Require a UUID `Idempotency-Key` on each question request. After membership validation, Express inserts a `question_requests` reservation keyed by workspace and UUID before calling either provider. It stores the caller and a SHA-256 fingerprint of the normalized question and `topK`. PostgreSQL's unique key serializes concurrent submissions. A matching completed request returns its saved answer without consuming the question rate limit or calling a provider. A changed request or different user cannot read that answer through the key.

The query embedding usage is saved immediately after successful retrieval. For a valid answer, the LLM usage row and replayable answer commit in one transaction. Usage event keys derive from the request key, so a second insert cannot silently double count the same operation. A citation rejection still records LLM usage, then marks the request uncertain. The browser keeps the key for a pending question in session storage and uses it for manual retries. A successful answer clears it.

An active duplicate returns `409 question_in_progress`. A request marked uncertain or still incomplete after two minutes returns `409 question_outcome_unknown`. The user must explicitly start a new attempt with a new UUID after checking workspace usage. A capacity rejection before any provider call removes the reservation so the same key can be retried. We do not automatically resume a question whose external call may already have completed.

## Guarantees and limits

This gives at-most-one _application-initiated_ provider sequence per key under normal database operation, and repeatable answers after the result commits. It does not make the provider and PostgreSQL one transaction. If the provider charges for a call and the API crashes before saving its usage, usage can undercount. If the user starts a new attempt, it may be charged again. A process can also die before making a provider call; the same conservative uncertain state then blocks that key. Provider-side request idempotency or reconciliation would be needed for stronger accounting.

The request rows contain answer text and cited excerpts, so database access and backups must remain private. They are currently retained with the workspace. Before unbounded production use, add a retention policy with a documented replay window; deleting a row ends its replay guarantee.
