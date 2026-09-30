ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'deleting', 'deleted'));
ALTER TABLE documents ADD COLUMN expires_at timestamptz;
ALTER TABLE documents ADD COLUMN deleted_at timestamptz;
ALTER TABLE documents DROP CONSTRAINT documents_storage_check;
ALTER TABLE documents ADD CONSTRAINT documents_storage_check
  CHECK (
    (status = 'deleted' AND content IS NULL AND storage_key IS NULL AND content_sha256 IS NULL)
    OR (status <> 'deleted' AND ((content IS NOT NULL) <> (storage_key IS NOT NULL)))
  );
CREATE INDEX documents_expiry_idx ON documents(expires_at)
  WHERE expires_at IS NOT NULL AND status IN ('completed', 'failed');

CREATE TABLE document_deletions (
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  object_key text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  claim_token uuid,
  locked_until timestamptz,
  PRIMARY KEY (workspace_id, document_id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX document_deletions_due_idx ON document_deletions(available_at, locked_until);

ALTER TABLE question_requests DROP CONSTRAINT question_requests_status_check;
ALTER TABLE question_requests ADD CONSTRAINT question_requests_status_check
  CHECK (status IN ('in_progress', 'completed', 'uncertain', 'invalidated'));
