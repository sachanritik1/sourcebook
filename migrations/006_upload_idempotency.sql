CREATE TABLE upload_idempotency (
  workspace_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  document_id uuid NOT NULL,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, job_id) REFERENCES processing_jobs(workspace_id, id) ON DELETE CASCADE
);
