# 0003: Checkpointed embeddings and exact tenant-scoped search

## Decision

The document worker now completes only after every extracted chunk has a vector for the configured model. PostgreSQL and pgvector store vectors with composite workspace/chunk foreign keys. The worker commits at most 32 vectors and one usage record per batch, then resumes from missing vectors on retry. A completed document can be reindexed through a new job and outbox event. Old vectors remain tagged with their model; search reads only the currently configured model.

The local provider hashes words into deterministic vectors for development and tests. It is lexical and does not provide semantic retrieval quality. Production can select the direct OpenAI SDK adapter with `EMBEDDING_PROVIDER=openai`. Both API and workers must use the same provider configuration. Search first checks membership and a Redis workspace rate limit, then embeds the query and uses exact cosine distance over vectors filtered by workspace and model. The SQL also checks membership so a revoked member cannot retrieve rows after the first check. Search returns chunks and source identifiers; answer generation and citation formatting are the next phase.

## Failure cases and limits

| Case                                            | Behavior                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Worker crashes after vector batch commit        | Retry skips that batch; the unique workspace/chunk/model key prevents duplicate vectors.                                   |
| Provider succeeds, worker crashes before commit | Retry may call the provider again. Cost tracking records committed batches only, so actual provider charges can be higher. |
| Provider returns 429 during indexing            | BullMQ retries the job with its configured exponential backoff.                                                            |
| Provider returns 429 during search              | API responds 503 with `Retry-After`; it does not run a hidden retry loop.                                                  |
| Redis is unavailable during search              | Search fails closed; document ingestion remains durable through PostgreSQL outbox.                                         |
| Provider model changes                          | Existing vectors are not mixed into new-model results. Reindex completed documents to populate the new model.              |

Exact search avoids an approximate index until the vector count and latency justify one. A future approximate index needs careful recall testing under tenant filters. The per-workspace rate limit shares a Redis key across API replicas. The one-job-per-workspace advisory lock protects workers, but shared queue ordering is not fully fair among tenants yet. The 500-chunk cap bounds one document's indexing work. Stored token usage and cost are estimates, not invoices.
