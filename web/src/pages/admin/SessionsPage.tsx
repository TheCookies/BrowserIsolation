import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getAdminSessions,
  joinAdminSession,
  terminateAdminSession,
  type AdminBrowserSession,
} from "../../api";
import { useAdminContext } from "./context";
import { formatBytes, formatTime } from "./format";

export function SessionsPage() {
  const { me } = useAdminContext();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AdminBrowserSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await getAdminSessions();
    setSessions(result.sessions);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load admin data.");
      });
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function onJoin(sessionId: string) {
    setBusyId(sessionId);
    setError(null);
    try {
      await joinAdminSession(sessionId, me.csrfToken);
      navigate(`/session/${sessionId}`);
    } catch {
      setBusyId(null);
      setError("Unable to join that session.");
    }
  }

  async function onTerminate(session: AdminBrowserSession) {
    const confirmed = window.confirm(
      `Terminate ${session.browser} session for ${session.owner}? This destroys the container.`,
    );
    if (!confirmed) return;
    setBusyId(session.id);
    setError(null);
    try {
      await terminateAdminSession(session.id, me.csrfToken);
      await refresh();
    } catch {
      setError("Unable to terminate that session.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Sessions</h1>
          <p className="hint">Live browser sessions. Join to watch, or terminate to destroy the container.</p>
        </div>
        {sessions ? (
          <span className={sessions.length ? "session-pill" : "session-pill idle"}>
            {sessions.length} active
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {sessions ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Owner</th>
                <th>Browser</th>
                <th>Worker</th>
                <th>Created</th>
                <th>Last activity</th>
                <th>Viewers</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={9}>
                    No active browser sessions.
                  </td>
                </tr>
              ) : (
                sessions.map((session) => (
                  <tr key={session.id}>
                    <td>{session.owner}</td>
                    <td>
                      <span className="badge">{session.browser}</span>
                    </td>
                    <td>
                      <span className="badge">{session.workerId}</span>
                    </td>
                    <td>{formatTime(session.createdAt)}</td>
                    <td>{formatTime(session.lastActivityAt)}</td>
                    <td>{session.viewers}</td>
                    <td>{session.cpuPercent === null ? "—" : `${session.cpuPercent.toFixed(1)}%`}</td>
                    <td>{formatBytes(session.memoryBytes)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={busyId === session.id}
                          onClick={() => void onJoin(session.id)}
                        >
                          Join
                        </button>
                        <button
                          type="button"
                          className="button-quiet danger"
                          disabled={busyId === session.id}
                          onClick={() => void onTerminate(session)}
                        >
                          Terminate
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : error ? null : (
        <p className="hint">
          <span className="loading-line" aria-hidden="true" /> Loading sessions…
        </p>
      )}
    </section>
  );
}
