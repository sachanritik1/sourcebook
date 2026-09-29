ALTER TABLE documents ALTER COLUMN content DROP NOT NULL;
ALTER TABLE documents ADD COLUMN storage_key text;
ALTER TABLE documents ADD COLUMN content_sha256 char(64)
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE documents ADD CONSTRAINT documents_storage_check
  CHECK ((content IS NOT NULL) <> (storage_key IS NOT NULL));
ALTER TABLE documents ADD CONSTRAINT documents_storage_digest_check
  CHECK (storage_key IS NULL OR content_sha256 IS NOT NULL);
CREATE UNIQUE INDEX documents_storage_key_idx ON documents(storage_key) WHERE storage_key IS NOT NULL;

CREATE TABLE upload_staging (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, idempotency_key)
);
CREATE INDEX upload_staging_cleanup_idx ON upload_staging(created_at)
  WHERE status IN ('pending', 'deleting');
