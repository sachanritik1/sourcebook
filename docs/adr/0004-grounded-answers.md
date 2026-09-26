# 0004: Grounded answers with validated citations

## Decision

`POST /workspaces/:workspaceId/questions` embeds the question, retrieves at most ten completed chunks under the caller's workspace membership, and sends numbered excerpts to an answer provider. The provider returns a structured answer, an insufficient-evidence flag, and excerpt numbers. The API maps those numbers to chunk and document IDs from the retrieved set. It rejects missing or out-of-range citations instead of returning an apparently sourced answer. No chunks means an immediate abstention without an LLM call.

The production adapter uses the OpenAI Responses API directly with a JSON schema and `store: false`. The local adapter extracts a sentence sharing words with the question; it is a development fallback, not an LLM or a semantic answer evaluator. Excerpts are explicitly treated as untrusted data in the system instruction. Validation establishes citation _identity_, but does not prove that the cited text supports every claim. Human review and evaluation examples are still needed before high-stakes use.

Answers are synchronous and transient. Ingestion remains asynchronous. The endpoint has a separate Redis limit of three questions per workspace per minute, while search keeps its ten-per-minute budget. We do not cache answers because the documents and model configuration can change. A direct provider interface keeps the mechanics visible and avoids a framework dependency in this slice.

## Failure and cost boundaries

| Case                                                       | Behavior                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Nonmember asks a question                                  | 404 before embedding or LLM work. Retrieval also checks membership in SQL.                              |
| No completed vectors for the active embedding model        | Abstain with no citations; query embedding usage is recorded.                                           |
| Provider returns an unknown citation number                | 502; no generated answer is returned. Provider token usage is still recorded.                           |
| Provider returns 429                                       | 503 with `Retry-After`; the request does not immediately retry an expensive call.                       |
| Provider completes but the API crashes before usage insert | A repeated request may incur another provider charge; persisted usage can underestimate actual charges. |

Usage stores provider-reported input and output tokens and configurable per-million-token estimates. Local extraction reports zero provider tokens. Prices and model IDs are configuration, so changing models requires updating both. This is cost visibility, not billing.
