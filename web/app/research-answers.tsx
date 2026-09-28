"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Citation = {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  excerpt: string;
};
type Answer = { answer: string; citations: Citation[]; model: string };
type Usage = {
  operation: string;
  model: string;
  inputTokens: string;
  outputTokens: string;
  estimatedCostUsd: string;
};

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.000001) return "<$0.000001";
  return `$${value.toFixed(6)}`;
}

function questionError(
  response: Response,
  body: Record<string, unknown>,
): string {
  const wait = response.headers.get("retry-after");
  const hint = wait && /^\d+$/.test(wait) ? ` Wait about ${wait} seconds.` : "";
  if (response.status === 429)
    return `This workspace has reached its question limit.${hint}`;
  if (body.error === "question_in_progress")
    return "The first request is still running. Retry this question in a moment.";
  if (body.error === "question_outcome_unknown")
    return "The provider outcome is unknown. Check usage before starting a new attempt; it may incur another charge.";
  if (body.error === "idempotency_key_reused")
    return "This request key belongs to another question. Start a new attempt.";
  if (body.error === "provider_quota_exhausted")
    return "The AI provider needs an account quota update before questions can run.";
  if (response.status === 503)
    return `The question service is unavailable.${hint} Retry this request before starting a new attempt.`;
  if (response.status === 502)
    return "The answer provider returned an invalid citation. No answer was shown.";
  return "The question failed. Check usage before trying again.";
}

export default function ResearchAnswers({
  workspaceId,
  hasCompletedDocument,
  onUnauthorized,
}: {
  workspaceId: string;
  hasCompletedDocument: boolean;
  onUnauthorized: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [usageError, setUsageError] = useState("");
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const activeAttempt = useRef<{ question: string; key: string } | null>(null);
  const attemptStorageKey = `research-question:${workspaceId}`;

  const loadUsage = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/usage`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error("Could not load usage.");
      const body = (await response.json()) as { usage: Usage[] };
      setUsage(body.usage);
      setUsageError("");
    } catch {
      setUsageError("Could not load usage. Refresh to try again.");
    }
  }, [workspaceId, onUnauthorized]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text || pending) return;
    setPending(true);
    setError("");
    setAnswer(null);
    setUnknownOutcome(false);
    let key =
      activeAttempt.current?.question === text
        ? activeAttempt.current.key
        : crypto.randomUUID();
    try {
      const previous = JSON.parse(
        sessionStorage.getItem(attemptStorageKey) ?? "null",
      ) as { question?: string; key?: string } | null;
      if (previous?.question === text && previous.key) key = previous.key;
      sessionStorage.setItem(
        attemptStorageKey,
        JSON.stringify({ question: text, key }),
      );
    } catch {
      // A live tab still uses one key for this submission if storage is disabled.
    }
    activeAttempt.current = { question: text, key };
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/questions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ question: text }),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        if (body.error === "question_outcome_unknown") setUnknownOutcome(true);
        throw new Error(questionError(response, body));
      }
      setAnswer(body as Answer);
      activeAttempt.current = null;
      try {
        sessionStorage.removeItem(attemptStorageKey);
      } catch {
        // Storage is optional; the server remains the source of truth.
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The question failed.",
      );
    } finally {
      setPending(false);
      void loadUsage();
    }
  }

  const embeddingTokens = usage
    .filter((row) => row.operation.startsWith("embedding"))
    .reduce((total, row) => total + Number(row.inputTokens), 0);
  const answerInputTokens = usage
    .filter((row) => row.operation === "llm_answer")
    .reduce((total, row) => total + Number(row.inputTokens), 0);
  const answerOutputTokens = usage
    .filter((row) => row.operation === "llm_answer")
    .reduce((total, row) => total + Number(row.outputTokens), 0);
  const estimatedCost = usage.reduce(
    (total, row) => total + Number(row.estimatedCostUsd),
    0,
  );

  return (
    <section className="answers-section" aria-labelledby="answers-title">
      <div className="answers-heading">
        <div>
          <p className="section-kicker">RESEARCH / ASK</p>
          <h3 id="answers-title">Ask your sources</h3>
        </div>
        <span>Answers reference indexed document chunks.</span>
      </div>
      <div className="answers-grid">
        <div>
          <form className="question-form" onSubmit={(event) => void ask(event)}>
            <label htmlFor="research-question">Your question</label>
            <textarea
              id="research-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="What do these documents say about…?"
            />
            <div className="question-actions">
              <span>
                {hasCompletedDocument
                  ? "Searches completed documents in this workspace."
                  : "Wait for a document to finish processing."}
              </span>
              <button
                className="primary-button"
                type="submit"
                disabled={pending || !question.trim() || !hasCompletedDocument}
              >
                {pending ? "Finding evidence…" : "Ask question"}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </form>
          {error && (
            <div className="notice" role="alert">
              {error}
              {unknownOutcome && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    activeAttempt.current = null;
                    try {
                      sessionStorage.removeItem(attemptStorageKey);
                    } catch {
                      // A new key is still created through the in-memory fallback.
                    }
                    setUnknownOutcome(false);
                    setError("");
                  }}
                >
                  Start a new attempt
                </button>
              )}
            </div>
          )}
          {answer && (
            <div className="answer-result" aria-live="polite">
              <div className="answer-label">ANSWER / {answer.model}</div>
              <p className="answer-text">{answer.answer}</p>
              {answer.citations.length > 0 ? (
                <div className="citation-list">
                  <h4>Sources</h4>
                  {answer.citations.map((citation, index) => (
                    <div className="citation" key={citation.chunkId}>
                      <div className="citation-heading">
                        <span>[{index + 1}]</span>
                        <strong>{citation.filename}</strong>
                        <span>Chunk {citation.ordinal + 1}</span>
                      </div>
                      <p>{citation.excerpt}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="answer-note">No supporting chunk was found.</p>
              )}
            </div>
          )}
        </div>
        <aside className="usage-panel" aria-labelledby="usage-title">
          <div className="usage-title-row">
            <div>
              <p className="panel-number">WORKSPACE / USAGE</p>
              <h3 id="usage-title">AI usage</h3>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => void loadUsage()}
            >
              Refresh ↻
            </button>
          </div>
          <p>Approximate totals from completed, recorded operations.</p>
          {usageError && (
            <p className="usage-error" role="alert">
              {usageError}
            </p>
          )}
          <dl className="usage-totals">
            <div>
              <dt>Embedding tokens</dt>
              <dd>{embeddingTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Answer input</dt>
              <dd>{answerInputTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Answer output</dt>
              <dd>{answerOutputTokens.toLocaleString()}</dd>
            </div>
            <div className="usage-cost">
              <dt>Estimated cost</dt>
              <dd>{formatCost(estimatedCost)}</dd>
            </div>
          </dl>
          {usage.length > 0 && (
            <div className="usage-breakdown">
              <h4>By operation</h4>
              {usage.map((row) => (
                <div key={`${row.operation}:${row.model}`}>
                  <strong>{row.operation.replaceAll("_", " ")}</strong>
                  <span>{row.model}</span>
                  <span>{formatCost(Number(row.estimatedCostUsd))}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
