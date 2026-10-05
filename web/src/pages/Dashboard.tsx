import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiError,
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
  const justDisconnected = Boolean(
    (location.state as { disconnected?: boolean } | null)?.disconnected,
  );
  const [options, setOptions] = useState<BrowserOption[] | null>(null);
  const [browser, setBrowser] = useState<BrowserChoice | null>(null);
  const [existing, setExisting] = useState<BrowserSession | null | undefined>(
    justDisconnected ? null : undefined,
  );
  const [pending, setPending] = useState(false);
  const [persistPending, setPersistPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!justDisconnected) return;
    // Clear one-shot navigation state so a refresh can see a real session again.
    navigate(".", { replace: true, state: null });
  }, [justDisconnected, navigate]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getMySession(), getBrowsers()])
      .then(([session, browsers]) => {
        if (cancelled) return;
        // After Disconnect, session teardown may still be in flight — don't show Reconnect.
        setExisting(justDisconnected ? null : session);
        setOptions(browsers.browsers);
        if (!justDisconnected && session) {
          setBrowser(session.browser);
        } else if (browsers.browsers[0]) {
          setBrowser(browsers.browsers[0].id);
        }
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
  }, [justDisconnected]);

  async function onLaunch() {
    if (!browser) return;
    setPending(true);
    setError(null);
    try {
      const result = await launchSession(browser, me.csrfToken);
      setExisting(result.session);
      navigate(`/session/${result.session.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "webrtc_port_pool_exhausted") {
        setError("No WebRTC ports are available. Try again later.");
      } else if (err instanceof ApiError && err.code === "browser_disabled") {
        setError("That browser is not enabled. Ask an administrator.");
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
      });
    } catch {
      setError("Unable to update persistence setting.");
    } finally {
      setPersistPending(false);
    }
  }

  const hasSession = Boolean(existing);
  const label = hasSession ? "Reconnect to session" : "Launch isolated browser";
  const checking = existing === undefined || options === null;
  const selectedTitle =
    options?.find((option) => option.id === browser)?.title ?? browser ?? "browser";

  return (
    <Shell me={me} onLogout={onLogout}>
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
                    disabled={hasSession || pending || checking}
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
              disabled={persistPending || hasSession}
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
