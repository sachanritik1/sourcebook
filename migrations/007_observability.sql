ALTER TABLE usage_events ADD COLUMN provider_latency_ms integer CHECK (provider_latency_ms >= 0);
