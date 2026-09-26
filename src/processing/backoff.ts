import {
  isProviderRateLimit,
  providerRetryAfterSeconds,
} from "../ai/embeddings";

export const PROVIDER_AWARE_BACKOFF = "provider-aware";

export function providerAwareBackoff(
  attemptsMade: number,
  type?: string,
  error?: Error,
): number {
  if (type !== PROVIDER_AWARE_BACKOFF)
    throw new Error(`Unknown backoff strategy: ${type}`);
  const exponentialMs = 1000 * 2 ** Math.max(0, attemptsMade - 1);
  const minimumMs = isProviderRateLimit(error)
    ? Math.max(exponentialMs, providerRetryAfterSeconds(error) * 1000)
    : exponentialMs;
  return minimumMs + Math.floor(Math.random() * 1000);
}
