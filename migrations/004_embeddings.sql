CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_workspace_id_id_unique UNIQUE (workspace_id, id);

CREATE TABLE document_embeddings (
  workspace_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  model text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, chunk_id, model),
  FOREIGN KEY (workspace_id, chunk_id) REFERENCES document_chunks(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX document_embeddings_workspace_model_idx ON document_embeddings(workspace_id, model);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid,
  event_key text NOT NULL UNIQUE,
  operation text NOT NULL CHECK (operation IN ('embedding_index', 'embedding_search')),
  model text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  estimated_cost_usd numeric(14, 8) NOT NULL CHECK (estimated_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, job_id) REFERENCES processing_jobs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX usage_events_workspace_created_idx ON usage_events(workspace_id, created_at DESC);
