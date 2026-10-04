import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { Me } from "./api";

export function Shell({
  me,
  onLogout,
  children,
}: {
  me: Me;
  onLogout: () => Promise<void>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setPending(true);
    setError(null);
    try {
      await onLogout();
    } catch {
      setError("Unable to log out. Try again.");
      setPending(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand" end>
          <span className="brand-dot" aria-hidden="true" />
          Browser Isolation
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : undefined)}>
            Dashboard
          </NavLink>
          {me.role === "admin" ? (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? "active" : undefined)}>
              Admin
            </NavLink>
          ) : null}
        </nav>
        <div className="account">
          <span className="who">
            <span className="who-name">{me.username}</span>
            <span className="who-role">{me.role === "admin" ? "Administrator" : "User"}</span>
          </span>
          <button type="button" className="button-quiet" onClick={() => void logout()} disabled={pending}>
            {pending ? "Logging out…" : "Log out"}
          </button>
        </div>
      </header>
      {error ? (
        <p className="alert banner" role="alert">
          {error}
        </p>
      ) : null}
      <main className="content">{children}</main>
    </div>
  );
}
