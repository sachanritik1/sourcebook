# 0010: Browser session boundary

## Decision

The first Next.js slice handles registration, login, logout, and workspace creation/listing. Route Handlers call the Express API from the server. The API remains the authority for credentials, membership, and workspace data. The browser receives an encrypted, authenticated, HttpOnly, SameSite=Lax cookie containing the API session; JavaScript receives only identity metadata. Mutating browser routes require the configured public `Origin`, which also covers CSRF attempts that can send a cookie.

The web server uses a 32-byte `WEB_SESSION_KEY`, separate from API credentials. Local Compose has a development-only default. A deployment must set a fresh secret, serve the web origin over HTTPS, keep the API on a private network, and set `WEB_PUBLIC_ORIGIN` to the actual browser origin. Rotating the key signs everyone out; this is acceptable for now. Logout revokes the API session before clearing the cookie, and an API outage leaves the cookie in place so the user can retry revocation.

## Trade-offs and next step

The encrypted cookie is simple and avoids a second session table. It cannot detect an API-side revocation until the next authenticated API call. A shared browser server also makes API IP-based auth limits count its server IP rather than individual clients. Before public deployment, put the web tier behind a trusted ingress and decide where per-client edge limits live; do not trust arbitrary forwarded IP headers from the browser. This phase shows workspaces only. Document upload, progress, and questions will use the same server-side session boundary in later slices.
