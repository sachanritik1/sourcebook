CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'text/plain')),
  content bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX documents_workspace_created_idx ON documents(workspace_id, created_at DESC);

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  current_event_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  stage text NOT NULL,
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  attempts_made integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
CREATE INDEX processing_jobs_workspace_status_idx ON processing_jobs(workspace_id, status, created_at DESC);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type = 'document.process'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  locked_until timestamptz,
  published_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  FOREIGN KEY (workspace_id, job_id) REFERENCES processing_jobs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX outbox_events_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;

CREATE TABLE processed_events (
  event_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, job_id) REFERENCES processing_jobs(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, document_id, ordinal)
);
CREATE INDEX document_chunks_workspace_document_idx ON document_chunks(workspace_id, document_id);

CREATE TABLE dead_letter_jobs (
  job_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  event_id uuid NOT NULL,
  reason text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  retried_at timestamptz,
  FOREIGN KEY (workspace_id, job_id) REFERENCES processing_jobs(workspace_id, id) ON DELETE CASCADE
);
