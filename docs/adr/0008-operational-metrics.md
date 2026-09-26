# 0008: Operational snapshot from durable records

## Decision

An optional, token-protected `/internal/metrics` endpoint reads BullMQ queue counts and PostgreSQL job, outbox, and usage records. The endpoint is disabled unless `METRICS_TOKEN` is set to at least 32 characters. It returns global aggregates without tenant identifiers. A private network should also restrict access in deployment.

Job duration means time from creation to final completion or failure, including queue wait. Answer latency measures successful answer-provider calls only and is stored on new usage events; older usage has no latency value. An average is `null` when no samples exist. Retry attempts count `attempts_made - 1` for each job's current event; manual retries reset that field, so this is not a lifetime total. Outbox publish retries are counted separately. Counts describe current rows and can decrease when data is deleted.

## Trade-offs

This read-only snapshot is easy to inspect locally and survives API restarts. It is not a time-series store; averages are all-time values and queries scan application tables. When load warrants it, scrape process-level Prometheus metrics and use bounded windows or rollups. Queue depth is unavailable while Redis is down, so the endpoint fails rather than reporting a misleading zero. `/health/ready` remains a PostgreSQL readiness check.
