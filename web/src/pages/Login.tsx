import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, getAuthMethods, login, type AuthMethods, type Me } from "../api";

export function LoginPage({ onSuccess }: { onSuccess: (me: Me) => void }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAuthMethods()
      .then((result) => {
        if (!cancelled) setMethods(result);
      })
      .catch(() => {
        if (!cancelled) setMethods({ local: true, saml: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "");
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      const me = await login(username, password);
      onSuccess(me);
      navigate("/");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_credentials"
          ? "Those credentials were not accepted."
          : "Unable to sign in. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  const samlEnabled = Boolean(methods?.saml);

  return (
    <main className="login-page">
      <section className="login-hero" aria-hidden="false">
        <div className="login-hero-inner">
          <div className="brand-mark large" aria-hidden="true" />
          <p className="login-hero-kicker">Secure remote browsing</p>
          <h1 className="brand-name">Browser Isolation</h1>
          <p className="login-hero-copy">
            Open the web inside disposable containers. Threats stay remote — your device stays clean.
          </p>
          <ul className="login-points">
            <li>Isolated Chrome, Firefox, and Brave sessions</li>
            <li>One browser per account, always disposable</li>
            <li>Admin oversight with live join and audit</li>
          </ul>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-form">
          <p className="eyebrow">Portal access</p>
          <h2 className="page-title">Sign in</h2>
          {samlEnabled ? (
            <>
              <p className="hint">Use your organization account, or a local break-glass password.</p>
              <a className="button-primary login-sso" href="/api/auth/saml/login">
                {methods?.ssoLabel ?? "Sign in with SSO"}
              </a>
              <p className="login-divider" role="separator">
                <span>or local account</span>
              </p>
            </>
          ) : (
            <p className="hint">Use the account issued for this portal.</p>
          )}
          <form onSubmit={onSubmit}>
            <label>
              Username
              <input name="username" autoComplete="username" required maxLength={64} />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
              />
            </label>
            {error ? (
              <p className="alert" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={pending}>
              {pending ? "Signing in…" : samlEnabled ? "Sign in with password" : "Sign in"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
