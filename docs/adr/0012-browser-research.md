# 0012: Browser research and visible evidence

## Decision

The browser sends a question to a Next.js Route Handler, which requires the configured `Origin` and forwards the authenticated request to Express. Express checks membership, embeds the question, retrieves workspace-scoped chunks, and validates the answer provider's citations. The answer response now includes the text of **cited** chunks alongside their IDs, filename, and ordinal. Each chunk is capped at 1,000 characters during indexing. This lets a user inspect the evidence without another source-read endpoint or a second authorization round trip. Uncited retrieved chunks stay out of the answer response.

The browser renders the answer and cited excerpts as plain text. It reads approximate token and cost totals from the existing workspace usage endpoint, with a manual refresh and a refresh after each question. The page disables questions until at least one document has completed, but the API can still abstain if the active embedding model has no matching vectors or the excerpts lack support. Answer replay persistence is described in ADR 0013; it is not a conversation history UI.

The web relay allows 70 seconds for a question because the embedding and answer adapters can each wait 30 seconds sequentially. A future ingress must allow that duration, or answers should become asynchronous. The relay forwards `Retry-After` and never automatically retries a failed question. The API remains the authority for rate limits, citations, and usage. The web server does not store provider keys or document context in browser state beyond the returned answer and cited excerpts.

## Trade-offs and failure cases

Returning the cited excerpt enlarges the answer response, but it is bounded and avoids a new endpoint. Citation identity is validated; the application does not prove every sentence is supported by the excerpt. If the provider completes and the API or web connection fails before the browser receives the answer, ADR 0013's request key can replay a committed answer. A provider call that completed just before an API crash remains uncertain and may be missing from usage; the UI exposes that state before the user starts a new attempt.
