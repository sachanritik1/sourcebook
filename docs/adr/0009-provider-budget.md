# 0009: Shared provider request budgets

## Decision

The API and worker use the same Redis fixed-window counter for embedding requests to one model. Answer calls use a separate counter. Only external providers are wrapped. The defaults are 60 embedding and 30 answer calls per minute, configurable independently. Each permitted call consumes a slot before contacting the provider, including calls that later fail.

The synchronous API returns 503 with `Retry-After` when its provider budget is full or Redis cannot check the budget. The worker moves a capacity-blocked BullMQ job to delayed state without marking the PostgreSQL job failed or spending its processing retry budget. The embedding checkpoint makes the resumed attempt safe. A small jitter spreads jobs waking at a minute boundary.

Provider-returned 429 errors remain bounded by existing worker retry settings. The API uses a valid provider `Retry-After` header when present, with a 30-second fallback. We do not defer every provider 429 indefinitely: some 429 responses mean quota or billing problems that require operator action.

## Trade-offs

Request-per-minute counts are easy to coordinate across API and worker replicas, but they do not enforce token-per-minute limits or provider-side concurrency. Fixed windows can burst at boundaries. Tune the configured limits below the actual provider account and model limits; provider 429s can still occur. At higher volume, use token estimates and provider response headers to adjust admission dynamically.
