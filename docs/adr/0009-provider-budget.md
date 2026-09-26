# 0009: Shared provider request budgets

## Decision

The API and worker use the same Redis fixed-window counter for embedding requests to one model. Answer calls use a separate counter. Only external providers are wrapped. The defaults are 60 embedding and 30 answer calls per minute, configurable independently. Each permitted call consumes a slot before contacting the provider, including calls that later fail.

The synchronous API returns 503 with `Retry-After` when its provider budget is full or Redis cannot check the budget. The worker moves a capacity-blocked BullMQ job to delayed state without marking the PostgreSQL job failed or spending its processing retry budget. The embedding checkpoint makes the resumed attempt safe. A small jitter spreads jobs waking at a minute boundary.

Temporary provider 429 errors use BullMQ's bounded attempt count. A custom backoff respects a valid provider `Retry-After` minimum and adds jitter; without a hint, it uses a 30-second fallback for 429. Other errors retain exponential backoff. The API also passes a valid `Retry-After` hint to clients. Known credit, spend, and usage-limit codes fail immediately into the durable dead-letter record and require operator action before manual retry. Unknown 429 codes remain bounded by the normal retry count.

The database can commit a permanent failure just before BullMQ records it. If the worker crashes in that gap, a replay sees the failed PostgreSQL status and does no processing. Manual retry creates a new event and resets the job to queued. Jobs published before this change retain their original exponential BullMQ backoff.

## Trade-offs

Request-per-minute counts are easy to coordinate across API and worker replicas, but they do not enforce token-per-minute limits or provider-side concurrency. Fixed windows can burst at boundaries. Tune the configured limits below the actual provider account and model limits; provider 429s can still occur. At higher volume, use token estimates and provider response headers to adjust admission dynamically.
