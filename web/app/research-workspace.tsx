"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { MAX_FILE_BYTES } from "@/lib/upload";

type Workspace = { id: string; name: string; role: string };
type Document = {
  id: string;
  filename: string;
  status: string;
  createdAt: string;
};
type Job = {
  id: string;
  documentId: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  progress: number;
  attemptsMade: number;
  maxAttempts: number;
  lastError: string | null;
};
type UploadDraft = {
  key: string;
  file: File;
  state: "ready" | "sending" | "error";
  error?: string;
};

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function requestError(status: number, body: Record<string, unknown>): string {
  if (status === 413) return "File exceeds the 5 MB limit.";
  if (status === 429 && body.error === "workspace_job_limit")
    return "This workspace has too many pending jobs. Try again after one finishes.";
  if (status === 429) return "Too many requests. Wait a moment and retry.";
  if (status === 409)
    return "This upload key was used for different content. Remove and re-add the file.";
  if (status === 503)
    return "The service is temporarily unavailable. Retry with the same file.";
  if (status === 400) return "Only valid PDF or UTF-8 text files are accepted.";
  return "The request failed. Try again.";
}

export default function ResearchWorkspace({
  workspace,
  onBack,
  onUnauthorized,
}: {
  workspace: Workspace;
  onBack: () => void;
  onUnauthorized: () => void;
}) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drafts, setDrafts] = useState<UploadDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [documentResponse, jobResponse] = await Promise.all([
        fetch(`/api/workspaces/${workspace.id}/documents`, {
          cache: "no-store",
        }),
        fetch(`/api/workspaces/${workspace.id}/jobs`, { cache: "no-store" }),
      ]);
      if (documentResponse.status === 401 || jobResponse.status === 401) {
        onUnauthorized();
        return;
      }
      const [documentBody, jobBody] = await Promise.all([
        payload(documentResponse),
        payload(jobResponse),
      ]);
      if (!documentResponse.ok)
        throw new Error(requestError(documentResponse.status, documentBody));
      if (!jobResponse.ok)
        throw new Error(requestError(jobResponse.status, jobBody));
      setDocuments((documentBody.documents as Document[]) ?? []);
      setJobs((jobBody.jobs as Job[]) ?? []);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load workspace.",
      );
    } finally {
      setLoading(false);
    }
  }, [workspace.id, onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActiveJobs = jobs.some(
    (job) => job.status === "queued" || job.status === "processing",
  );
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [hasActiveJobs, refresh]);

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setDrafts((current) => [
      ...current,
      ...files.map((file) => ({
        key: crypto.randomUUID(),
        file,
        state: "ready" as const,
      })),
    ]);
    event.target.value = "";
  }

  async function sendDraft(draft: UploadDraft) {
    if (draft.file.size > MAX_FILE_BYTES) {
      setDrafts((current) =>
        current.map((item) =>
          item.key === draft.key
            ? { ...item, state: "error", error: "File exceeds the 5 MB limit." }
            : item,
        ),
      );
      return;
    }
    setDrafts((current) =>
      current.map((item) =>
        item.key === draft.key
          ? { ...item, state: "sending", error: undefined }
          : item,
      ),
    );
    try {
      const form = new FormData();
      form.append("file", draft.file, draft.file.name);
      const response = await fetch(
        `/api/workspaces/${workspace.id}/documents`,
        {
          method: "POST",
          headers: { "Idempotency-Key": draft.key },
          body: form,
        },
      );
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const body = await payload(response);
      if (!response.ok) throw new Error(requestError(response.status, body));
      setDrafts((current) => current.filter((item) => item.key !== draft.key));
      await refresh();
    } catch (error) {
      setDrafts((current) =>
        current.map((item) =>
          item.key === draft.key
            ? {
                ...item,
                state: "error",
                error:
                  error instanceof Error ? error.message : "Upload failed.",
              }
            : item,
        ),
      );
    }
  }

  async function uploadAll() {
    setSending(true);
    for (const draft of drafts) await sendDraft(draft);
    setSending(false);
  }

  async function retryJob(jobId: string) {
    setRetryingJob(jobId);
    setMessage("");
    try {
      const response = await fetch(`/api/jobs/${jobId}/retry`, {
        method: "POST",
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const body = await payload(response);
      if (!response.ok) throw new Error(requestError(response.status, body));
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not retry job.",
      );
    } finally {
      setRetryingJob(null);
    }
  }

  return (
    <section className="research" aria-labelledby="research-title">
      <button className="back-link" type="button" onClick={onBack}>
        ← All workspaces
      </button>
      <div className="research-heading">
        <div>
          <p className="section-kicker">
            WORKSPACE / {workspace.role.toUpperCase()}
          </p>
          <h2 id="research-title">{workspace.name}</h2>
        </div>
        <button
          className="text-button"
          type="button"
          onClick={() => void refresh()}
        >
          Refresh ↻
        </button>
      </div>
      {message && (
        <p className="notice" role="alert">
          {message}
        </p>
      )}
      <div className="research-grid">
        <div>
          <div className="list-heading">
            <h3>
              Documents <span>{documents.length}</span>
            </h3>
            <span>PRIVATE SOURCES</span>
          </div>
          {loading ? (
            <p className="muted">Loading documents…</p>
          ) : documents.length ? (
            <div className="document-list">
              {documents.map((item) => (
                <div className="document-row" key={item.id}>
                  <span className="document-icon" aria-hidden="true">
                    ▤
                  </span>
                  <div>
                    <strong>{item.filename}</strong>
                    <span>
                      {new Date(item.createdAt).toLocaleDateString()} ·{" "}
                      {item.id.slice(0, 8)}
                    </span>
                  </div>
                  <span className={`status status-${item.status}`}>
                    {item.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="list-empty">
              No documents yet. Add a PDF or text file to begin.
            </p>
          )}

          <div className="list-heading jobs-heading">
            <h3>
              Processing jobs <span>{jobs.length}</span>
            </h3>
            <span>AUTO-UPDATING WHILE ACTIVE</span>
          </div>
          {loading ? (
            <p className="muted">Loading jobs…</p>
          ) : jobs.length ? (
            <div className="job-list">
              {jobs.map((job) => (
                <div className="job-row" key={job.id}>
                  <div className="job-top">
                    <strong>
                      {documents.find((item) => item.id === job.documentId)
                        ?.filename ?? job.documentId.slice(0, 8)}
                    </strong>
                    <span className={`status status-${job.status}`}>
                      {job.status}
                    </span>
                  </div>
                  <div className="job-meta">
                    <span>{job.stage.replaceAll("_", " ")}</span>
                    <span>{job.progress}%</span>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label={`Processing ${job.id}`}
                    aria-valuenow={job.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, job.progress))}%`,
                      }}
                    />
                  </div>
                  <div className="job-foot">
                    <span>
                      Job {job.id} · attempt {job.attemptsMade}/
                      {job.maxAttempts}
                    </span>
                    {job.status === "failed" && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={retryingJob === job.id}
                        onClick={() => void retryJob(job.id)}
                      >
                        Retry job ↗
                      </button>
                    )}
                  </div>
                  {job.status === "failed" && job.lastError && (
                    <p className="job-error">{job.lastError}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="list-empty">No processing jobs yet.</p>
          )}
        </div>

        <div className="upload-panel">
          <p className="panel-number">SOURCES / ADD</p>
          <h3>Add documents</h3>
          <p>
            Choose PDF or UTF-8 text files. Each file becomes a separate
            processing job.
          </p>
          <label className="file-picker" htmlFor="source-files">
            Choose files <span aria-hidden="true">＋</span>
          </label>
          <input
            id="source-files"
            className="visually-hidden"
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            multiple
            onChange={addFiles}
          />
          <p className="upload-limit">
            Up to 5 MB per file · private to members
          </p>
          {drafts.length > 0 && (
            <div className="draft-list">
              {drafts.map((draft) => (
                <div className="draft-row" key={draft.key}>
                  <div>
                    <strong>{draft.file.name}</strong>
                    <span>
                      {draft.state === "sending"
                        ? "Sending…"
                        : (draft.error ??
                          `${(draft.file.size / 1024).toFixed(0)} KB · ready`)}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${draft.file.name}`}
                    disabled={sending}
                    onClick={() =>
                      setDrafts((current) =>
                        current.filter((item) => item.key !== draft.key),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={sending || drafts.length === 0}
            onClick={() => void uploadAll()}
          >
            {sending
              ? "Uploading…"
              : `Upload ${drafts.length || ""} ${drafts.length === 1 ? "file" : "files"}`}
            <span aria-hidden="true">↗</span>
          </button>
          <p className="form-note">
            If a response is lost, retry here with the same file. The upload key
            stays with it until you remove it or leave this page.
          </p>
        </div>
      </div>
    </section>
  );
}
