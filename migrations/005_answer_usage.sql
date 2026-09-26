ALTER TABLE usage_events ADD COLUMN output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0);
ALTER TABLE usage_events DROP CONSTRAINT usage_events_operation_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_operation_check
  CHECK (operation IN ('embedding_index', 'embedding_search', 'llm_answer'));
