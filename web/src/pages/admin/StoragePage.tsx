import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  deleteAdminProfileVolume,
  getAdminProfileVolumes,
  type AdminProfileUsageByUser,
  type AdminProfileVolume,
} from "../../api";
import { useAdminContext } from "./context";
import { formatBytes, formatTime } from "./format";

function volumeErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.code) {
    case "volume_in_use":
      return "That volume is in use by a running session. Terminate the session first.";
    case "worker_unreachable":
      return "The worker hosting that volume is unreachable.";
    case "not_found":
      return "That volume no longer exists.";
    default:
      return err.message && err.message !== err.code ? err.message : fallback;
  }
}

export function StoragePage() {
  const { me } = useAdminContext();
  const [volumes, setVolumes] = useState<AdminProfileVolume[] | null>(null);
  const [totalBytes, setTotalBytes] = useState(0);
  const [byUser, setByUser] = useState<AdminProfileUsageByUser[]>([]);
  const [volumeErrors, setVolumeErrors] = useState<Array<{ workerId: string; error: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadVolumes = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAdminProfileVolumes();
      setVolumes(result.volumes);
      setTotalBytes(result.totalBytes);
      setByUser(result.byUser ?? []);
      setVolumeErrors(result.errors ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadVolumes()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load persistent volumes.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadVolumes]);

  async function onDelete(volume: AdminProfileVolume) {
    const user = volume.username ?? volume.subjectKey ?? "unknown";
    const browser = volume.browser ?? "unknown";
    const confirmed = window.confirm(
      `Delete persistent profile for ${user} / ${browser} on ${volume.workerId}? This cannot be undone.`,
    );
    if (!confirmed) return;
    const key = `${volume.workerId}:${volume.volumeName}`;
    setBusyKey(key);
    setMessage(null);
    setError(null);
    try {
      await deleteAdminProfileVolume(
        { workerId: volume.workerId, volumeName: volume.volumeName },
        me.csrfToken,
      );
      setMessage(`Deleted persistent profile for ${user} / ${browser}.`);
      await loadVolumes();
    } catch (err) {
      setError(volumeErrorMessage(err, "Unable to delete that volume."));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Storage</h1>
          <p className="hint">
            Saved browser profiles per user on each worker. Delete a volume to clear that profile.
          </p>
        </div>
        <div className="panel-actions">
          {volumes ? (
            <span className="session-pill idle">
              {volumes.length} volume(s) · {formatBytes(totalBytes)}
            </span>
          ) : null}
          <button
            type="button"
            className="button-quiet"
            disabled={loading || busyKey !== null}
            onClick={() =>
              void loadVolumes()
                .then(() => setError(null))
                .catch(() => setError("Unable to load persistent volumes."))
            }
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className="settings-saved">{message}</p> : null}
      {volumeErrors.length > 0 ? (
        <p className="alert" role="alert">
          Could not read volumes from:{" "}
          {volumeErrors.map((item) => `${item.workerId} (${item.error})`).join(", ")}
        </p>
      ) : null}

      {volumes ? (
        <>
          <h2 className="admin-subhead">Usage by user</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Volumes</th>
                  <th>Total size</th>
                </tr>
              </thead>
              <tbody>
                {byUser.length === 0 ? (
                  <tr>
                    <td className="empty" colSpan={3}>
                      No persistent profile usage.
                    </td>
                  </tr>
                ) : (
                  byUser.map((row) => (
                    <tr key={row.subjectKey}>
                      <td>
                        {row.username ?? (
                          <span className="hint" title={row.subjectKey}>
                            unknown
                          </span>
                        )}
                      </td>
                      <td>{row.volumeCount}</td>
                      <td>{formatBytes(row.sizeBytes)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h2 className="admin-subhead">Volumes</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Browser</th>
                  <th>Worker</th>
                  <th>Size</th>
                  <th>Persist</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {volumes.length === 0 ? (
                  <tr>
                    <td className="empty" colSpan={7}>
                      No persistent profile volumes found.
                    </td>
                  </tr>
                ) : (
                  volumes.map((volume) => {
                    const key = `${volume.workerId}:${volume.volumeName}`;
                    return (
                      <tr key={key}>
                        <td>
                          {volume.username ?? (
                            <span className="hint" title={volume.subjectKey ?? undefined}>
                              unknown
                            </span>
                          )}
                        </td>
                        <td>{volume.browser ?? "—"}</td>
                        <td>{volume.workerId}</td>
                        <td>{formatBytes(volume.sizeBytes)}</td>
                        <td>
                          {volume.persistProfileEnabled === null
                            ? "—"
                            : volume.persistProfileEnabled
                              ? "yes"
                              : "no"}
                        </td>
                        <td>{formatTime(volume.createdAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="button-quiet danger"
                              disabled={busyKey !== null}
                              onClick={() => void onDelete(volume)}
                            >
                              {busyKey === key ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : error ? null : (
        <p className="hint">
          <span className="loading-line" aria-hidden="true" /> Loading volumes…
        </p>
      )}
    </section>
  );
}
