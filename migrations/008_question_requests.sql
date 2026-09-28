CREATE TABLE question_requests (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'uncertain')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, idempotency_key),
  CHECK ((status = 'completed') = (response_body IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
