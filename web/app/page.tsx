"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import ResearchWorkspace from "./research-workspace";

type Workspace = { id: string; name: string; role: string };
type Identity = { userId: string; email: string };

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorMessage(
  status: number,
  payload: Record<string, unknown>,
): string {
  if (status === 429) return "Too many requests. Please wait a moment.";
  if (status === 503)
    return "The service is temporarily unavailable. Try again shortly.";
  if (payload.error === "email_taken")
    return "That email is already registered.";
  if (status === 401) return "Check your email and password.";
  if (status === 400) return "Check the details and try again.";
  return "Something went wrong. Try again.";
}

export default function Home() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(
    null,
  );
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [message, setMessage] = useState("");

  const loadWorkspaces = useCallback(async () => {
    const response = await fetch("/api/workspaces", { cache: "no-store" });
    if (response.status === 401) {
      setIdentity(null);
      setWorkspaces([]);
      setSelectedWorkspace(null);
      return;
    }
    const payload = await json(response);
    if (!response.ok) throw new Error(errorMessage(response.status, payload));
    setWorkspaces((payload.workspaces as Workspace[]) ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (response.ok && active) {
          const user = (await response.json()) as Identity;
          setIdentity(user);
          await loadWorkspaces();
        }
      } catch {
        if (active)
          setMessage("Could not reach the service. Refresh to try again.");
      } finally {
        if (active) setChecking(false);
      }
    }
    void check();
    return () => {
      active = false;
    };
  }, [loadWorkspaces]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, email, password }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(errorMessage(response.status, payload));
      setIdentity(payload as Identity);
      setPassword("");
      await loadWorkspaces();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workspaceName.trim() }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(errorMessage(response.status, payload));
      setWorkspaceName("");
      await loadWorkspaces();
      setSelectedWorkspace({
        ...(payload as { id: string; name: string }),
        role: "owner",
      });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create workspace.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
      setIdentity(null);
      setWorkspaces([]);
      setSelectedWorkspace(null);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not sign out.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label="Sourcebook home">
            <span className="brand-mark" aria-hidden="true">
              S
            </span>
            <span>
              sourcebook<span className="brand-dot">.</span>
            </span>
          </a>
          <span className="topbar-label">Research workspace</span>
        </div>
      </header>

      <main className="page">
        <div className="eyebrow">
          <span className="eyebrow-line" /> DOCUMENT RESEARCH / 01
        </div>
        <div className="intro">
          <div>
            <h1>
              Make sense of
              <br />
              <em>what you read.</em>
            </h1>
            <p className="lead">
              A focused home for your source documents and the questions they
              answer.
            </p>
          </div>
          <div className="intro-aside">
            <span>01 — ORGANIZE</span>
            <span>02 — PROCESS</span>
            <span>03 — RESEARCH</span>
          </div>
        </div>

        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
        {checking ? (
          <p className="muted" role="status">
            Opening your desk…
          </p>
        ) : identity && selectedWorkspace ? (
          <ResearchWorkspace
            key={selectedWorkspace.id}
            workspace={selectedWorkspace}
            onBack={() => setSelectedWorkspace(null)}
            onUnauthorized={() => {
              setIdentity(null);
              setWorkspaces([]);
              setSelectedWorkspace(null);
            }}
          />
        ) : identity ? (
          <section className="desk" aria-labelledby="desk-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">YOUR DESK</p>
                <h2 id="desk-title">Workspaces</h2>
              </div>
              <div className="account">
                <span>{identity.email}</span>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void signOut()}
                >
                  Sign out ↗
                </button>
              </div>
            </div>
            <div className="desk-grid">
              <div className="workspace-list">
                {workspaces.length ? (
                  workspaces.map((workspace, index) => (
                    <button
                      className="workspace-row"
                      type="button"
                      key={workspace.id}
                      onClick={() => setSelectedWorkspace(workspace)}
                    >
                      <span className="row-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <strong>{workspace.name}</strong>
                        <span className="row-meta">
                          {workspace.role} · {workspace.id.slice(0, 8)}
                        </span>
                      </div>
                      <span className="workspace-open" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <span className="empty-icon">↗</span>
                    <strong>Your desk is ready.</strong>
                    <p>Create a workspace to start organizing research.</p>
                  </div>
                )}
              </div>
              <form
                className="side-panel"
                onSubmit={(event) => void createWorkspace(event)}
              >
                <p className="panel-number">NEW / 001</p>
                <h3>Create a workspace</h3>
                <p>Keep a project&apos;s documents and research together.</p>
                <label htmlFor="workspace-name">Workspace name</label>
                <input
                  id="workspace-name"
                  maxLength={100}
                  required
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="e.g. Market research"
                />
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy || !workspaceName.trim()}
                >
                  Create workspace <span aria-hidden="true">↗</span>
                </button>
              </form>
            </div>
          </section>
        ) : (
          <section className="auth-section" aria-labelledby="auth-title">
            <div className="auth-copy">
              <p className="section-kicker">GET STARTED</p>
              <h2 id="auth-title">
                Your research
                <br />
                starts here.
              </h2>
              <p>
                Sign in to return to your desk, or create an account for a new
                one.
              </p>
              <span className="auth-rule" />
            </div>
            <form
              className="auth-form"
              onSubmit={(event) => void submitAuth(event)}
            >
              <div className="mode-switch" aria-label="Account action">
                <button
                  type="button"
                  className={mode === "login" ? "active" : ""}
                  onClick={() => {
                    setMode("login");
                    setMessage("");
                  }}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={mode === "register" ? "active" : ""}
                  onClick={() => {
                    setMode("register");
                    setMessage("");
                  }}
                >
                  Create account
                </button>
              </div>
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 12 characters"
              />
              <button className="primary-button" type="submit" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : mode === "login"
                    ? "Sign in"
                    : "Create account"}
                <span aria-hidden="true">↗</span>
              </button>
              <p className="form-note">
                Your documents are private to workspace members.
              </p>
            </form>
          </section>
        )}
      </main>
      <footer className="footer">
        <span>SOURCEBOOK / RESEARCH DESK</span>
        <span>Built for evidence.</span>
      </footer>
    </div>
  );
}
