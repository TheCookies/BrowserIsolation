import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  getAdminAudit,
  type AdminAuditActionDef,
  type AdminAuditEvent,
} from "../../api";
import { formatTime } from "./format";

function fromLocalInputValue(local: string): string | undefined {
  if (!local.trim()) return undefined;
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function AuditPage() {
  const [events, setEvents] = useState<AdminAuditEvent[] | null>(null);
  const [catalog, setCatalog] = useState<AdminAuditActionDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");
  const [appliedActor, setAppliedActor] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [appliedFrom, setAppliedFrom] = useState("");
  const [appliedTo, setAppliedTo] = useState("");

  const labelFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of catalog) map.set(item.id, item.label);
    return (id: string) => map.get(id) ?? id;
  }, [catalog]);

  const load = useCallback(() => {
    return getAdminAudit({
      actor: appliedActor || undefined,
      action: appliedAction || undefined,
      from: fromLocalInputValue(appliedFrom),
      to: fromLocalInputValue(appliedTo),
      limit: 500,
    }).then((result) => {
      setEvents(result.events);
      setCatalog(result.catalog);
    });
  }, [appliedAction, appliedActor, appliedFrom, appliedTo]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load admin data.");
      });
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setAppliedActor(actor.trim());
    setAppliedAction(action);
    setAppliedFrom(fromLocal);
    setAppliedTo(toLocal);
  }

  function clearFilters() {
    setActor("");
    setAction("");
    setFromLocal("");
    setToLocal("");
    setAppliedActor("");
    setAppliedAction("");
    setAppliedFrom("");
    setAppliedTo("");
  }

  const filtersActive = Boolean(appliedActor || appliedAction || appliedFrom || appliedTo);

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Audit log</h1>
          <p className="hint">
            Administrator and user actions across sessions, accounts, workers, storage, and
            settings.
          </p>
        </div>
        {events ? (
          <span className="session-pill idle">{events.length} event(s)</span>
        ) : null}
      </div>

      <form className="admin-toolbar audit-filters" onSubmit={applyFilters}>
        <label className="audit-filter-field">
          <span>From</span>
          <input
            type="datetime-local"
            value={fromLocal}
            onChange={(event) => setFromLocal(event.target.value)}
            aria-label="Filter from date"
          />
        </label>
        <label className="audit-filter-field">
          <span>To</span>
          <input
            type="datetime-local"
            value={toLocal}
            onChange={(event) => setToLocal(event.target.value)}
            aria-label="Filter to date"
          />
        </label>
        <label className="audit-filter-field audit-filter-actor">
          <span>User</span>
          <input
            type="text"
            className="admin-search"
            placeholder="Actor username"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            aria-label="Filter by user"
          />
        </label>
        <label className="audit-filter-field">
          <span>Action</span>
          <select
            aria-label="Filter by action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">All actions</option>
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="audit-filter-actions">
          <button type="submit" className="button-primary">
            Apply
          </button>
          <button type="button" className="button-quiet" onClick={clearFilters} disabled={!filtersActive && !actor && !action && !fromLocal && !toLocal}>
            Clear
          </button>
        </div>
      </form>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {events ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={5}>
                    {filtersActive ? "No events match these filters." : "No actions recorded yet."}
                  </td>
                </tr>
              ) : (
                events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatTime(event.createdAt)}</td>
                    <td>{event.actor}</td>
                    <td>
                      <span className="badge" title={event.action}>
                        {labelFor(event.action)}
                      </span>
                    </td>
                    <td>{event.owner || "—"}</td>
                    <td>{event.detail ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : error ? null : (
        <p className="hint">
          <span className="loading-line" aria-hidden="true" /> Loading audit log…
        </p>
      )}
    </section>
  );
}
