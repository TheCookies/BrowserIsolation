import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiError,
  destroyMySession,
  getBrowsers,
  getMySession,
  launchSession,
  setPersistProfile,
  type BrowserChoice,
  type BrowserOption,
  type BrowserSession,
  type Me,
} from "../api";
import { LaunchStatusOverlay } from "../LaunchStatusOverlay";
import { Shell } from "../Shell";

export function DashboardPage({
  me,
  onLogout,
  onMe,
}: {
  me: Me;
  onLogout: () => Promise<void>;
  onMe: (me: Me) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [teardownPending, setTeardownPending] = useState(
    () => Boolean((location.state as { disconnected?: boolean } | null)?.disconnected),
  );
  const [options, setOptions] = useState<BrowserOption[] | null>(null);
  const [browser, setBrowser] = useState<BrowserChoice | null>(null);
  const [existing, setExisting] = useState<BrowserSession | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [persistPending, setPersistPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Clear one-shot navigation state so a refresh can see a real session again.
    navigate(".", { replace: true, state: null });
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;

    function applyLoaded(session: BrowserSession | null, browsers: BrowserOption[]) {
      setOptions(browsers);
      if (teardownPending && session) {
        // Destroy may still be running after Disconnect — don't treat as an active reconnect.
        setExisting(null);
        setBrowser((prev) => prev ?? browsers[0]?.id ?? null);
        return;
      }
      if (teardownPending && !session) {
        setTeardownPending(false);
      }
      setExisting(session);
      if (session) {
        setBrowser(session.browser);
      } else {
        setBrowser((prev) => prev ?? browsers[0]?.id ?? null);
      }
    }

    Promise.all([getMySession(), getBrowsers()])
      .then(([session, browsers]) => {
        if (cancelled) return;
        applyLoaded(session, browsers.browsers);
      })
      .catch(() => {
        if (!cancelled) {
          setExisting(null);
          setError("Unable to load browser options.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teardownPending]);

  useEffect(() => {
    if (!teardownPending) return;
    let cancelled = false;

    async function ensureTeardown() {
      try {
        await destroyMySession(me.csrfToken);
      } catch {
        /* Session page may already have started destroy; poll until DB reflects it. */
      }
      while (!cancelled) {
        try {
          const session = await getMySession();
          if (cancelled) return;
          if (!session) {
            setTeardownPending(false);
            setExisting(null);
            return;
          }
        } catch {
          if (!cancelled) setTeardownPending(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    void ensureTeardown();
    return () => {
      cancelled = true;
    };
  }, [me.csrfToken, teardownPending]);

  async function onLaunch() {
    if (!browser) return;
    setPending(true);
    setError(null);
    try {
      if (teardownPending) {
        try {
          await destroyMySession(me.csrfToken);
        } catch {
          /* background destroy from the session page may have already finished */
        }
        setTeardownPending(false);
        setExisting(null);
      }
      const result = await launchSession(browser, me.csrfToken);
      setExisting(result.session);
      navigate(`/session/${result.session.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "webrtc_port_pool_exhausted") {
        setError("No WebRTC ports are available. Try again later.");
      } else if (err instanceof ApiError && err.code === "browser_disabled") {
        setError("That browser is not enabled. Ask an administrator.");
      } else if (err instanceof ApiError && err.code === "no_workers_available") {
        setError("No workers are online. Authorize a worker in Admin → Workers, or enable the local worker.");
      } else if (err instanceof ApiError && (err.code === "worker_auth_failed" || err.message === "worker_auth_failed")) {
        setError("A worker rejected the orchestrator token. Re-enroll or re-authorize that worker.");
      } else if (err instanceof ApiError && err.message && err.message !== err.code) {
        setError(`Unable to launch a browser: ${err.message}`);
      } else {
        setError("Unable to launch a browser. Try again.");
      }
      setPending(false);
    }
  }

  async function onPersistToggle(next: boolean) {
    setPersistPending(true);
    setError(null);
    try {
      const prefs = await setPersistProfile(next, me.csrfToken);
      onMe({
        ...me,
        persistProfile: prefs.persistProfile,
        persistProfilesEnabled: prefs.persistProfilesEnabled,
        darkMode: prefs.darkMode,
      });
    } catch {
      setError("Unable to update persistence setting.");
    } finally {
      setPersistPending(false);
    }
  }

  const hasSession = Boolean(existing) && !teardownPending;
  const label = hasSession ? "Reconnect to session" : "Launch isolated browser";
  const checking = existing === undefined || options === null;
  const choicesLocked = pending || checking;
  const selectedTitle =
    options?.find((option) => option.id === browser)?.title ?? browser ?? "browser";

  return (
    <Shell me={me} onLogout={onLogout} onMe={onMe}>
      <section className="dash-hero">
        <div>
          <p className="panel-kicker">Workspace</p>
          <h1>Remote browser</h1>
          <p className="hint dash-hero-copy">
            Launch a disposable browser in an isolated container. Threats never touch your local
            machine.
          </p>
        </div>
        {checking ? (
          <span className="session-pill idle">Checking…</span>
        ) : hasSession ? (
          <span className="session-pill">Session active</span>
        ) : (
          <span className="session-pill idle">Ready to launch</span>
        )}
      </section>

      <section className="card wide launch-card">
        <fieldset>
          <legend>Choose a browser</legend>
          {options && options.length === 0 ? (
            <p className="hint">No browsers are enabled. Ask an administrator.</p>
          ) : (
            <div className="choices">
              {(options ?? []).map((option) => (
                <label
                  key={option.id}
                  className={browser === option.id ? "choice selected" : "choice"}
                >
                  <input
                    type="radio"
                    name="browser"
                    value={option.id}
                    checked={browser === option.id}
                    disabled={choicesLocked}
                    onChange={() => setBrowser(option.id)}
                  />
                  <img
                    className="browser-logo"
                    src={`/browsers/${option.logo}`}
                    alt=""
                    width={40}
                    height={40}
                    draggable={false}
                  />
                  <span className="choice-copy">
                    <span className="choice-title">{option.title}</span>
                    <span className="choice-meta">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {me.persistProfilesEnabled ? (
          <label className={`persist-toggle${me.persistProfile ? " on" : ""}`}>
            <input
              type="checkbox"
              checked={me.persistProfile}
              disabled={persistPending || choicesLocked || hasSession}
              onChange={(event) => void onPersistToggle(event.target.checked)}
            />
            <span className="persist-copy">
              <span>Keep my browser profile between sessions</span>
              <span className="choice-meta">
                Cookies and logins persist in a private volume for your account.
              </span>
            </span>
          </label>
        ) : null}

        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}

        <div className="actions">
          <button
            type="button"
            className="button-primary"
            disabled={pending || checking || !browser || (!hasSession && (options?.length ?? 0) === 0)}
            onClick={() => void onLaunch()}
          >
            {pending ? "Starting…" : label}
          </button>
          {hasSession && browser ? (
            <p className="hint">Reconnects to your existing {selectedTitle} session.</p>
          ) : null}
        </div>
      </section>

      <LaunchStatusOverlay
        active={pending}
        title={hasSession ? "Reconnecting to your session" : "Launching remote browser"}
        browserTitle={selectedTitle}
      />
    </Shell>
  );
}
