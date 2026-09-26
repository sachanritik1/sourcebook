# 0007: Redis limits at the API edge

## Decision

The API uses a Redis atomic increment and TTL for fixed one-minute windows. General routes allow 120 requests per client IP per minute by default; registration and login share a stricter 10-per-minute IP budget. Search and questions retain their workspace budgets. Health probes bypass the limits. `429` responses include `Retry-After`.

The API trusts the socket peer as the client IP by default. `TRUST_PROXY_HOPS` is 0 locally and must match a deployment's trusted reverse-proxy hops; setting it incorrectly can let callers spoof `X-Forwarded-For`. A per-IP limit can affect users behind the same NAT. We keep this simple first, then add authenticated user or workspace limits where usage data shows a need.

General routes **fail open** if Redis is unavailable. This keeps authenticated uploads possible while the outbox remains durable in PostgreSQL. Registration and login **fail closed** with 503 if their limiter is unavailable, to avoid an unbounded password-guessing path. Search and questions also fail closed because they can incur provider cost. The API Redis connection disables offline command queuing so failure is prompt rather than waiting for a reconnect.

## Trade-offs

Fixed windows are easy to inspect and atomic across API replicas, but requests near a minute boundary can burst above the nominal per-minute rate. A sliding window or token bucket is an option if measured traffic needs smoother enforcement. Redis limits are operational controls, not a billing or authorization boundary. Tenant membership checks still protect data.

An attacker can send unbounded general requests while Redis is down because that path favors availability. An upstream load balancer or WAF should enforce a coarse edge limit in a public deployment. `TRUST_PROXY_HOPS` should be set only when direct client access to the API is blocked.
