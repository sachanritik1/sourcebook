ALTER TABLE processing_jobs ADD COLUMN last_reconciled_at timestamptz;
CREATE INDEX processing_jobs_reconcile_idx
  ON processing_jobs(updated_at, last_reconciled_at)
  WHERE status IN ('queued', 'processing');
