import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  getAdminBrowsers,
  pullAdminBrowsersStream,
  updateAdminBrowsers,
  type AdminBrowserCatalogItem,
  type BrowserPullStreamEvent,
} from "../../api";
import { useAdminContext } from "./context";

function formatBytes(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function progressLine(event: Extract<BrowserPullStreamEvent, { type: "progress" }>): string {
  const bits = [event.status];
  if (event.id) bits.push(event.id.slice(0, 12));
  if (event.detail) bits.push(event.detail);
  else if (typeof event.current === "number" && typeof event.total === "number" && event.total > 0) {
    bits.push(`${formatBytes(event.current)} / ${formatBytes(event.total)}`);
  }
  if (typeof event.percent === "number") bits.push(`${event.percent.toFixed(1)}%`);
  return `[${event.image}] ${bits.join(" · ")}`;
}

export function BrowsersPage() {
  const { me } = useAdminContext();
  const [catalog, setCatalog] = useState<AdminBrowserCatalogItem[] | null>(null);
  const [imageTag, setImageTag] = useState("latest");
  const [browserDraft, setBrowserDraft] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [browsersMessage, setBrowsersMessage] = useState<string | null>(null);
  const [savingBrowsers, setSavingBrowsers] = useState(false);
  const [pullingBrowsers, setPullingBrowsers] = useState(false);

  const [pullOpen, setPullOpen] = useState(false);
  const [pullLines, setPullLines] = useState<string[]>([]);
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullCurrentImage, setPullCurrentImage] = useState<string | null>(null);
  const [pullDone, setPullDone] = useState(false);
  const [pullFailed, setPullFailed] = useState(false);
  const consoleRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadBrowsers = useCallback(async () => {
    const result = await getAdminBrowsers();
    setCatalog(result.browsers);
    setImageTag(result.tag);
    const next: Record<string, boolean> = {};
    for (const browser of result.browsers) next[browser.id] = browser.enabled;
    setBrowserDraft(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadBrowsers()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load admin data.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadBrowsers]);

  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [pullLines]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const browsersDirty = useMemo(() => {
    if (!catalog) return false;
    return catalog.some((browser) => (browserDraft[browser.id] ?? false) !== browser.enabled);
  }, [catalog, browserDraft]);

  const enabledCount = useMemo(
    () => Object.values(browserDraft).filter(Boolean).length,
    [browserDraft],
  );

  async function runPullStream(images?: string[], notice?: string | null) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPullingBrowsers(true);
    setBrowsersMessage(notice ?? null);
    setError(null);
    setPullOpen(true);
    setPullLines([]);
    setPullPercent(null);
    setPullCurrentImage(null);
    setPullDone(false);
    setPullFailed(false);

    try {
      await pullAdminBrowsersStream(
        me.csrfToken,
        (event) => {
          if (event.type === "start") {
            appendPullLine(event.message);
            for (const image of event.images) appendPullLine(`  · ${image}`);
            return;
          }
          if (event.type === "progress") {
            setPullCurrentImage(event.image);
            if (typeof event.percent === "number") setPullPercent(event.percent);
            appendPullLine(progressLine(event));
            return;
          }
          if (event.type === "done") {
            appendPullLine(event.message);
            for (const row of event.results) {
              appendPullLine(
                row.ok
                  ? `  ✓ ${row.image}${row.workerId ? ` (${row.workerId})` : ""}`
                  : `  ✗ ${row.image}${row.workerId ? ` (${row.workerId})` : ""}${
                      row.error ? `: ${row.error}` : ""
                    }`,
              );
            }
            if (event.ok) setPullPercent(100);
            setPullDone(true);
            setPullFailed(!event.ok);
            if (event.ok) {
              setBrowsersMessage(
                notice
                  ? `${notice} Pulled image(s) at tag ${event.tag}.`
                  : `Pulled image(s) at tag ${event.tag}.`,
              );
            } else {
              setError(event.message);
            }
            return;
          }
          if (event.type === "error") {
            appendPullLine(`ERROR: ${event.message}`);
            setPullDone(true);
            setPullFailed(true);
            setError(event.message);
          }
        },
        controller.signal,
        images,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        appendPullLine("Pull cancelled.");
        setPullDone(true);
        return;
      }
      const message =
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to pull browser images.";
      appendPullLine(`ERROR: ${message}`);
      setPullDone(true);
      setPullFailed(true);
      setError(message);
    } finally {
      setPullingBrowsers(false);
      setPullDone(true);
    }
  }

  async function onSaveBrowsers() {
    if (!browsersDirty || enabledCount === 0) return;
    setSavingBrowsers(true);
    setBrowsersMessage(null);
    setError(null);
    const enabled = Object.entries(browserDraft)
      .filter(([, on]) => on)
      .map(([id]) => id);
    try {
      const result = await updateAdminBrowsers(enabled, me.csrfToken);
      setCatalog(result.browsers);
      setImageTag(result.tag);
      const next: Record<string, boolean> = {};
      for (const browser of result.browsers) next[browser.id] = browser.enabled;
      setBrowserDraft(next);

      const removedOk = result.removedImages.filter((row) => row.ok).length;
      const removedFail = result.removedImages.filter((row) => !row.ok).length;
      const parts = [`Saved ${enabled.length} enabled browser(s).`];
      if (result.added.length) parts.push(`Added ${result.added.length}.`);
      if (result.removed.length) {
        parts.push(
          removedFail > 0
            ? `Removed ${result.removed.length}; deleted ${removedOk} image(s), ${removedFail} failed.`
            : `Removed ${result.removed.length}; deleted ${removedOk} image(s).`,
        );
      }
      const notice = parts.join(" ");

      if (result.pullImages.length > 0) {
        setSavingBrowsers(false);
        await runPullStream(result.pullImages, notice);
        return;
      }

      setBrowsersMessage(notice);
      if (removedFail > 0) {
        setError("Some disabled browser images could not be deleted. See audit log for details.");
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to save browser selection.",
      );
    } finally {
      setSavingBrowsers(false);
    }
  }

  function appendPullLine(line: string) {
    setPullLines((prev) => {
      const next = prev.length > 800 ? prev.slice(-600) : prev;
      return [...next, line];
    });
  }

  async function onPullLatest() {
    if (enabledCount === 0) {
      setError("Enable at least one browser before pulling images.");
      return;
    }
    if (browsersDirty) {
      setError("Save your browser selection before pulling.");
      return;
    }
    await runPullStream();
  }

  function closePullModal() {
    if (pullingBrowsers) {
      abortRef.current?.abort();
    }
    setPullOpen(false);
  }

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Browsers</h1>
          <p className="hint">
            Choose which browsers users can launch. Saving pulls newly enabled images onto the main
            host and every authorized worker; Pull latest refreshes them all. Tag:{" "}
            <strong>{imageTag}</strong>.
          </p>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="button-quiet"
            disabled={
              pullingBrowsers || savingBrowsers || enabledCount === 0 || browsersDirty || !catalog
            }
            onClick={() => void onPullLatest()}
          >
            {pullingBrowsers ? "Pulling…" : "Pull latest"}
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={savingBrowsers || !browsersDirty || enabledCount === 0}
            onClick={() => void onSaveBrowsers()}
          >
            {savingBrowsers
              ? "Saving…"
              : browsersDirty
                ? `Save ${enabledCount} enabled`
                : "No changes"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {browsersMessage ? <p className="settings-saved">{browsersMessage}</p> : null}
      {catalog ? (
        <div className="browser-check-grid">
          {catalog.map((browser) => (
            <label
              key={browser.id}
              className={browserDraft[browser.id] ? "browser-check on" : "browser-check"}
            >
              <input
                type="checkbox"
                checked={Boolean(browserDraft[browser.id])}
                disabled={savingBrowsers || pullingBrowsers}
                onChange={(event) =>
                  setBrowserDraft((prev) => ({
                    ...prev,
                    [browser.id]: event.target.checked,
                  }))
                }
              />
              <img
                className="browser-logo"
                src={`/browsers/${browser.logo}`}
                alt=""
                width={32}
                height={32}
                draggable={false}
              />
              <span className="choice-copy">
                <span className="choice-title">{browser.title}</span>
                <span className="choice-meta">{browser.description}</span>
              </span>
            </label>
          ))}
        </div>
      ) : error ? null : (
        <p className="hint">
          <span className="loading-line" aria-hidden="true" /> Loading browsers…
        </p>
      )}

      {pullOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closePullModal}>
          <div
            className="modal-panel modal-panel-wide pull-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pull-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <div>
                <h2 id="pull-modal-title">Pulling browser images</h2>
                <p className="hint">
                  {pullCurrentImage
                    ? `Current: ${pullCurrentImage}`
                    : pullingBrowsers
                      ? "Starting…"
                      : pullFailed
                        ? "Finished with errors"
                        : "Finished"}
                </p>
              </div>
              <button type="button" className="button-quiet" onClick={closePullModal}>
                {pullingBrowsers ? "Cancel" : "Close"}
              </button>
            </div>

            <div className="pull-progress-block">
              <div className="pull-progress-label">
                <strong>Progress</strong>
                <span>{typeof pullPercent === "number" ? `${pullPercent.toFixed(1)}%` : "—"}</span>
              </div>
              <div
                className="pull-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={typeof pullPercent === "number" ? Math.round(pullPercent) : 0}
              >
                <div
                  className="pull-progress-fill"
                  style={{ width: `${typeof pullPercent === "number" ? pullPercent : 0}%` }}
                />
              </div>
            </div>

            <pre className="pull-console" ref={consoleRef} aria-live="polite">
              {pullLines.length ? pullLines.join("\n") : "Waiting for pull output…"}
            </pre>

            {pullDone ? (
              <p className={pullFailed ? "alert" : "settings-saved"} role="status">
                {pullFailed ? "Pull finished with errors. See console above." : "Pull complete."}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
