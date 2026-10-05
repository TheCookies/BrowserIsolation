import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ApiError, changePassword, type Me } from "./api";

function passwordChangeError(err: unknown): string {
  if (!(err instanceof ApiError)) return "Unable to change password. Try again.";
  switch (err.code) {
    case "invalid_current_password":
      return "Current password is incorrect.";
    case "password_unchanged":
      return "Choose a new password that is different from the current one.";
    case "invalid_password":
      return "Enter a valid new password.";
    case "password_change_unavailable":
      return "Password changes are not available for this account.";
    case "csrf_failed":
      return "Session expired. Refresh the page and try again.";
    default:
      return err.message && err.message !== err.code
        ? err.message
        : "Unable to change password. Try again.";
  }
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const titleId = useId();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!passwordOpen) return;
    const timer = window.setTimeout(() => currentPasswordRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [passwordOpen]);

  useEffect(() => {
    if (!passwordOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !passwordPending) closePasswordModal();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [passwordOpen, passwordPending]);

  function openPasswordModal() {
    setMenuOpen(false);
    setPasswordOpen(true);
    setPasswordPending(false);
    setPasswordError(null);
    setPasswordSuccess(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  function closePasswordModal() {
    if (passwordPending) return;
    setPasswordOpen(false);
    setPasswordError(null);
    setPasswordSuccess(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function logout() {
    setMenuOpen(false);
    setPending(true);
    setError(null);
    try {
      await onLogout();
    } catch {
      setError("Unable to log out. Try again.");
      setPending(false);
    }
  }

  async function onChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordPending || passwordSuccess) return;

    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }
    if (!newPassword) {
      setPasswordError("Enter a new password.");
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError("Choose a new password that is different from the current one.");
      return;
    }

    setPasswordPending(true);
    setPasswordError(null);
    try {
      await changePassword({ currentPassword, newPassword }, me.csrfToken);
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(passwordChangeError(err));
    } finally {
      setPasswordPending(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand" end>
          {me.logoUrl ? (
            <img className="brand-logo" src={me.logoUrl} alt="" width={28} height={28} draggable={false} />
          ) : (
            <span className="brand-dot" aria-hidden="true" />
          )}
          {me.siteName || "Browser Isolation"}
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
        <div className="account" ref={menuRef}>
          <button
            type="button"
            className={`account-trigger${menuOpen ? " open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            disabled={pending}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="who">
              <span className="who-name">{me.username}</span>
              <span className="who-role">{me.role === "admin" ? "Administrator" : "User"}</span>
            </span>
            <span className="account-caret" aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div className="account-menu" id={menuId} role="menu">
              <div className="account-menu-heading">
                <span className="account-menu-name">{me.username}</span>
                <span className="account-menu-role">
                  {me.role === "admin" ? "Administrator" : "User"}
                </span>
              </div>
              <button type="button" className="account-menu-item" role="menuitem" disabled>
                Profile
                <span className="account-menu-soon">Soon</span>
              </button>
              {me.canChangePassword ? (
                <button
                  type="button"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={openPasswordModal}
                >
                  Change password
                </button>
              ) : null}
              <button
                type="button"
                className="account-menu-item danger"
                role="menuitem"
                disabled={pending}
                onClick={() => void logout()}
              >
                {pending ? "Logging out…" : "Log out"}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      {error ? (
        <p className="alert banner" role="alert">
          {error}
        </p>
      ) : null}
      <main className="content">{children}</main>

      {passwordOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closePasswordModal}>
          <div
            className="modal-panel password-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <div>
                <h2 id={titleId}>Change password</h2>
                <p className="hint">Update the password for your local portal account.</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closePasswordModal}
                disabled={passwordPending}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {passwordSuccess ? (
              <div className="password-modal-success">
                <p className="settings-saved" role="status">
                  Password updated. Use the new password the next time you sign in.
                </p>
                <div className="actions">
                  <button type="button" className="button-primary" onClick={closePasswordModal}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form className="password-modal-form" onSubmit={(event) => void onChangePassword(event)}>
                <label>
                  Current password
                  <input
                    ref={currentPasswordRef}
                    type="password"
                    name="currentPassword"
                    autoComplete="current-password"
                    required
                    maxLength={256}
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    disabled={passwordPending}
                  />
                </label>
                <label>
                  New password
                  <input
                    type="password"
                    name="newPassword"
                    autoComplete="new-password"
                    required
                    maxLength={256}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    disabled={passwordPending}
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    type="password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    maxLength={256}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    disabled={passwordPending}
                  />
                </label>
                {passwordError ? (
                  <p className="alert" role="alert">
                    {passwordError}
                  </p>
                ) : null}
                <div className="actions password-modal-actions">
                  <button
                    type="button"
                    className="button-quiet"
                    onClick={closePasswordModal}
                    disabled={passwordPending}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="button-primary" disabled={passwordPending}>
                    {passwordPending ? "Updating…" : "Update password"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
