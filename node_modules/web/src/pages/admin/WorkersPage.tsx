import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createAdminWorker,
  deleteAdminWorker,
  getAdminWorkerStatus,
  getAdminWorkers,
  setAdminWorkerEnabled,
  type AdminWorker,
  type WorkerStatusDetails,
} from "../../api";
import { useAdminContext } from "./context";
import { formatBytes, formatTime } from "./format";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return "—";
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatLinkSpeed(mbps: number | null): string {
  if (mbps === null) return "link speed n/a";
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gbps`;
  return `${mbps} Mbps`;
}

function meterClass(percent: number): string {
  if (percent >= 90) return "meter-fill danger";
  if (percent >= 75) return "meter-fill warn";
  return "meter-fill";
}

function workerStatusLabel(worker: AdminWorker): string {
  if (worker.kind === "local") {
    if (!worker.enabled) return "Disabled";
    return worker.online ? "Online" : "Offline";
  }
  if (!worker.enabled) {
    return worker.lastSeenAt ? "Deauthorized" : "Pending";
  }
  return worker.online ? "Online" : "Offline";
}

export function WorkersPage() {
  const { me } = useAdminContext();
  const [workers, setWorkers] = useState<AdminWorker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workersMessage, setWorkersMessage] = useState<string | null>(null);
  const [workerBusy, setWorkerBusy] = useState<string | null>(null);
  const [newWorkerId, setNewWorkerId] = useState("");
  const [newWorkerUrl, setNewWorkerUrl] = useState("");
  const [newWorkerIp, setNewWorkerIp] = useState("");
  const [newWorkerToken, setNewWorkerToken] = useState("");
  const [statusWorkerId, setStatusWorkerId] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusDetails | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const loadWorkers = useCallback(async () => {
    const result = await getAdminWorkers();
    setWorkers(result.workers);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadWorkers()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load admin data.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadWorkers]);

  async function onCreateWorker() {
    setWorkerBusy("create");
    setWorkersMessage(null);
    setError(null);
    try {
      await createAdminWorker(
        {
          id: newWorkerId.trim(),
          baseUrl: newWorkerUrl.trim(),
          publicIp: newWorkerIp.trim(),
          token: newWorkerToken,
        },
        me.csrfToken,
      );
      setNewWorkerId("");
      setNewWorkerUrl("");
      setNewWorkerIp("");
      setNewWorkerToken("");
      setWorkersMessage("Worker added.");
      await loadWorkers();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.code : "Unable to add worker.");
    } finally {
      setWorkerBusy(null);
    }
  }

  async function onToggleWorker(worker: AdminWorker, enabled: boolean) {
    setWorkerBusy(worker.id);
    setWorkersMessage(null);
    setError(null);
    try {
      const result = await setAdminWorkerEnabled(worker.id, enabled, me.csrfToken);
      if (enabled && result.probeError) {
        setWorkersMessage(
          `Authorized ${worker.id}, but it is still unreachable (${result.probeError}). Check worker agent / token / network.`,
        );
      } else if (enabled && result.worker && !result.worker.online) {
        setWorkersMessage(`Authorized ${worker.id}, but it is offline. Check worker health.`);
      } else if (enabled && result.pullingImages) {
        setWorkersMessage(
          `Authorized ${worker.id}. Pulling ${result.pullImageCount ?? "enabled"} browser image(s) onto it in the background.`,
        );
      } else {
        setWorkersMessage(enabled ? `Authorized ${worker.id}.` : `Deauthorized ${worker.id}.`);
      }
      await loadWorkers();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.code : "Unable to update worker.");
    } finally {
      setWorkerBusy(null);
    }
  }

  async function onDeleteWorker(worker: AdminWorker) {
    if (!window.confirm(`Remove worker ${worker.id}? Running sessions on it are not moved.`)) {
      return;
    }
    setWorkerBusy(worker.id);
    setWorkersMessage(null);
    setError(null);
    try {
      await deleteAdminWorker(worker.id, me.csrfToken);
      setWorkersMessage(`Removed ${worker.id}.`);
      await loadWorkers();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.code : "Unable to remove worker.");
    } finally {
      setWorkerBusy(null);
    }
  }

  async function onViewWorkerStatus(worker: AdminWorker) {
    setStatusWorkerId(worker.id);
    setWorkerStatus(null);
    setStatusError(null);
    setStatusLoading(true);
    try {
      const result = await getAdminWorkerStatus(worker.id);
      setWorkerStatus(result);
    } catch (err: unknown) {
      setStatusError(
        err instanceof ApiError
          ? err.code === "worker_unreachable"
            ? "Worker is unreachable."
            : err.code
          : "Unable to load worker status.",
      );
    } finally {
      setStatusLoading(false);
    }
  }

  function closeStatus() {
    setStatusWorkerId(null);
    setWorkerStatus(null);
    setStatusError(null);
  }

  return (
    <>
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Workers</h1>
          <p className="hint">
            Hosts that run browser containers. Prefer the Alma worker bootstrap script; authorize
            pending workers here. New sessions go to the least-loaded online worker.
          </p>
        </div>
        {workers ? (
          <span className="session-pill idle">
            {workers.filter((worker) => worker.online && worker.enabled).length} online
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {workersMessage ? <p className="settings-saved">{workersMessage}</p> : null}
      <div className="workers-manual-add">
        <p className="hint workers-deprecated-hint">
          Deprecated — prefer <code>install-worker.sh</code> on the worker host. Manual add remains
          as a fallback and will be removed in a later version.
        </p>
        <form
          className="admin-create admin-create-workers"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreateWorker();
          }}
        >
          <label>
            Name
            <input
              value={newWorkerId}
              onChange={(event) => setNewWorkerId(event.target.value)}
              required
              placeholder="edge-1"
            />
          </label>
          <label>
            Agent URL
            <input
              value={newWorkerUrl}
              onChange={(event) => setNewWorkerUrl(event.target.value)}
              required
              placeholder="http://10.0.0.5:8090"
            />
          </label>
          <label>
            Public IP
            <input
              value={newWorkerIp}
              onChange={(event) => setNewWorkerIp(event.target.value)}
              required
              placeholder="10.0.0.5"
            />
          </label>
          <label>
            Token
            <input
              type="password"
              value={newWorkerToken}
              onChange={(event) => setNewWorkerToken(event.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={workerBusy === "create"}>
            {workerBusy === "create" ? "Adding…" : "Add worker"}
          </button>
        </form>
      </div>
      {workers ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Public IP</th>
                <th>Status</th>
                <th>Sessions</th>
                <th>Last seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={7}>
                    No workers registered.
                  </td>
                </tr>
              ) : (
                workers.map((worker) => (
                  <tr key={worker.id}>
                    <td>{worker.id}</td>
                    <td>
                      <span className="badge">
                        {worker.kind === "local" ? "Local" : "Remote"}
                      </span>
                    </td>
                    <td>{worker.publicIp}</td>
                    <td>
                      <span
                        className={`badge worker-status-${workerStatusLabel(worker).toLowerCase()}`}
                      >
                        {workerStatusLabel(worker)}
                      </span>
                    </td>
                    <td>{worker.activeSessions}</td>
                    <td>{formatTime(worker.lastSeenAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={statusLoading && statusWorkerId === worker.id}
                          onClick={() => void onViewWorkerStatus(worker)}
                        >
                          Status
                        </button>
                        {worker.kind === "remote" ? (
                          <button
                            type="button"
                            className="button-quiet"
                            disabled={workerBusy === worker.id}
                            onClick={() => void onToggleWorker(worker, !worker.enabled)}
                          >
                            {worker.enabled ? "Deauthorize" : "Authorize"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="button-quiet"
                            disabled={workerBusy === worker.id}
                            onClick={() => void onToggleWorker(worker, !worker.enabled)}
                          >
                            {worker.enabled ? "Disable" : "Enable"}
                          </button>
                        )}
                        {worker.kind === "remote" ? (
                          <button
                            type="button"
                            className="button-quiet danger"
                            disabled={workerBusy === worker.id}
                            onClick={() => void onDeleteWorker(worker)}
                          >
                            Remove
                          </button>
                        ) : null}
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
          <span className="loading-line" aria-hidden="true" /> Loading workers…
        </p>
      )}
    </section>
      {statusWorkerId ? (
        <div className="modal-backdrop" role="presentation" onClick={closeStatus}>
          <div
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="worker-status-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <div>
                <h2 id="worker-status-title">{statusWorkerId}</h2>
              </div>
              <button type="button" className="button-quiet" onClick={closeStatus}>
                Close
              </button>
            </div>
            {statusLoading ? <p className="hint">Sampling CPU / memory / disk…</p> : null}
            {statusError ? (
              <p className="alert" role="alert">
                {statusError}
              </p>
            ) : null}
            {workerStatus ? (
              <div className="worker-status">
                <p className="hint">
                  {workerStatus.host.hostname} · {workerStatus.host.platform} · uptime{" "}
                  {formatUptime(workerStatus.host.uptimeSeconds)} ·{" "}
                  {workerStatus.worker.activeSessions} session(s) · sampled{" "}
                  {formatTime(workerStatus.host.collectedAt)}
                </p>

                <div className="meter-block">
                  <div className="meter-label">
                    <strong>CPU</strong>
                    <span>
                      {workerStatus.host.cpu.usagePercent === null
                        ? "—"
                        : `${workerStatus.host.cpu.usagePercent.toFixed(1)}%`}{" "}
                      · {workerStatus.host.cpu.cores} cores · load{" "}
                      {workerStatus.host.cpu.load1.toFixed(2)} /{" "}
                      {workerStatus.host.cpu.load5.toFixed(2)} /{" "}
                      {workerStatus.host.cpu.load15.toFixed(2)}
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className={meterClass(workerStatus.host.cpu.usagePercent ?? 0)}
                      style={{ width: `${Math.min(100, workerStatus.host.cpu.usagePercent ?? 0)}%` }}
                    />
                  </div>
                  {workerStatus.host.cpu.model ? (
                    <p className="hint meter-sub">{workerStatus.host.cpu.model}</p>
                  ) : null}
                </div>

                <div className="meter-block">
                  <div className="meter-label">
                    <strong>Memory (RAM)</strong>
                    <span>
                      {formatBytes(workerStatus.host.memory.usedBytes)} /{" "}
                      {formatBytes(workerStatus.host.memory.totalBytes)} (
                      {workerStatus.host.memory.usedPercent.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className={meterClass(workerStatus.host.memory.usedPercent)}
                      style={{ width: `${Math.min(100, workerStatus.host.memory.usedPercent)}%` }}
                    />
                  </div>
                </div>

                {workerStatus.host.disks.map((disk) => (
                  <div key={disk.path} className="meter-block">
                    <div className="meter-label">
                      <strong>Disk {disk.path}</strong>
                      <span>
                        {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)} (
                        {disk.usedPercent.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="meter-track">
                      <div
                        className={meterClass(disk.usedPercent)}
                        style={{ width: `${Math.min(100, disk.usedPercent)}%` }}
                      />
                    </div>
                  </div>
                ))}

                {(workerStatus.host.network?.interfaces ?? []).length > 0 ? (
                  <div className="meter-block">
                    <div className="meter-label">
                      <strong>Network</strong>
                      <span>sampled {workerStatus.host.network.sampleMs}ms · ↓/↑ throughput</span>
                    </div>
                    <div className="network-ifaces">
                      {workerStatus.host.network.interfaces.map((iface) => {
                        const util = iface.utilizationPercent;
                        return (
                          <div key={iface.name} className="network-iface">
                            <div className="meter-label">
                              <strong>
                                {iface.name}
                                {iface.state ? (
                                  <span className="hint meter-sub"> ({iface.state})</span>
                                ) : null}
                              </strong>
                              <span>
                                ↓ {formatRate(iface.rxBytesPerSec)} · ↑{" "}
                                {formatRate(iface.txBytesPerSec)}
                                {iface.linkMbps !== null
                                  ? ` · ${formatLinkSpeed(iface.linkMbps)}`
                                  : ""}
                                {util !== null ? ` · ${util.toFixed(1)}%` : ""}
                              </span>
                            </div>
                            {util !== null ? (
                              <div className="meter-track">
                                <div
                                  className={meterClass(util)}
                                  style={{ width: `${Math.min(100, util)}%` }}
                                />
                              </div>
                            ) : (
                              <p className="hint meter-sub">
                                total ↓ {formatBytes(iface.rxBytes)} · ↑{" "}
                                {formatBytes(iface.txBytes)}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="button-quiet"
                  disabled={statusLoading}
                  onClick={() => {
                    const current = workers?.find((item) => item.id === statusWorkerId);
                    if (current) void onViewWorkerStatus(current);
                  }}
                >
                  Refresh
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
