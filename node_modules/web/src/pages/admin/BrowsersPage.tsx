import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  getAdminBrowsers,
  pullAdminBrowsers,
  updateAdminBrowsers,
  type AdminBrowserCatalogItem,
} from "../../api";
import { useAdminContext } from "./context";

export function BrowsersPage() {
  const { me } = useAdminContext();
  const [catalog, setCatalog] = useState<AdminBrowserCatalogItem[] | null>(null);
  const [imageTag, setImageTag] = useState("latest");
  const [browserDraft, setBrowserDraft] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [browsersMessage, setBrowsersMessage] = useState<string | null>(null);
  const [savingBrowsers, setSavingBrowsers] = useState(false);
  const [pullingBrowsers, setPullingBrowsers] = useState(false);

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

  const browsersDirty = useMemo(() => {
    if (!catalog) return false;
    return catalog.some((browser) => (browserDraft[browser.id] ?? false) !== browser.enabled);
  }, [catalog, browserDraft]);

  const enabledCount = useMemo(
    () => Object.values(browserDraft).filter(Boolean).length,
    [browserDraft],
  );

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
      setBrowsersMessage(`Saved ${enabled.length} enabled browser(s).`);
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

  async function onPullLatest() {
    if (enabledCount === 0) {
      setError("Enable at least one browser before pulling images.");
      return;
    }
    if (browsersDirty) {
      setError("Save your browser selection before pulling.");
      return;
    }
    setPullingBrowsers(true);
    setBrowsersMessage(null);
    setError(null);
    try {
      const result = await pullAdminBrowsers(me.csrfToken);
      const ok = result.results.filter((row) => row.ok).length;
      const failed = result.results.filter((row) => !row.ok);
      if (failed.length === 0) {
        setBrowsersMessage(`Pulled ${ok} image(s) at tag ${result.tag}.`);
      } else {
        setError(
          `Pulled ${ok}/${result.results.length}. Failed: ${failed
            .map((row) => `${row.image}${row.error ? ` (${row.error})` : ""}`)
            .join("; ")}`,
        );
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to pull browser images.",
      );
    } finally {
      setPullingBrowsers(false);
    }
  }

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Browsers</h1>
          <p className="hint">
            Choose which browsers users can launch. Images use tag <strong>{imageTag}</strong>.
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
    </section>
  );
}
