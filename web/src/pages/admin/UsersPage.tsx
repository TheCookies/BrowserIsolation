import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  createAdminUser,
  deleteAdminUser,
  getAdminProfileVolumes,
  getAdminUsers,
  updateAdminUser,
  type AdminLocalUser,
  type AdminProfileUsageByUser,
  type Role,
} from "../../api";
import { useAdminContext } from "./context";
import { formatBytes, formatTime } from "./format";

const PAGE_SIZE = 50;

function userErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.code) {
    case "username_taken":
      return "That username is already taken.";
    case "invalid_username":
      return "Username may only contain letters, digits, and . _ @ -";
    case "invalid_password":
      return "Password is required.";
    case "last_admin":
      return "You cannot remove or demote the last administrator.";
    case "cannot_delete_self":
      return "You cannot delete your own account while signed in.";
    case "not_found":
      return "That user no longer exists.";
    default:
      return err.message && err.message !== err.code ? err.message : fallback;
  }
}

export function UsersPage() {
  const { me } = useAdminContext();
  const [users, setUsers] = useState<AdminLocalUser[] | null>(null);
  const [usage, setUsage] = useState<AdminProfileUsageByUser[] | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<Role>("user");
  const [userBusy, setUserBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usersMessage, setUsersMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [page, setPage] = useState(0);

  const loadUsers = useCallback(async () => {
    const result = await getAdminUsers();
    setUsers(result.users);
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const result = await getAdminProfileVolumes();
      setUsage(result.byUser ?? []);
    } catch {
      // Storage usage is supplementary; the user table still works without it.
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadUsers(), loadUsage()])
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load admin data.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadUsers, loadUsage]);

  const usageIndex = useMemo(() => {
    const bySubject = new Map<string, AdminProfileUsageByUser>();
    const byName = new Map<string, AdminProfileUsageByUser>();
    for (const row of usage ?? []) {
      if (row.subjectId) bySubject.set(row.subjectId, row);
      if (row.username) byName.set(row.username, row);
    }
    return { bySubject, byName };
  }, [usage]);

  function usageFor(user: AdminLocalUser): AdminProfileUsageByUser | undefined {
    return usageIndex.bySubject.get(user.subjectId) ?? usageIndex.byName.get(user.username);
  }

  const filtered = useMemo(() => {
    if (!users) return [] as AdminLocalUser[];
    const needle = query.trim().toLowerCase();
    return users.filter((user) => {
      if (roleFilter !== "all" && user.role !== roleFilter) return false;
      if (!needle) return true;
      return (
        user.username.toLowerCase().includes(needle) ||
        user.subjectId.toLowerCase().includes(needle) ||
        user.role.toLowerCase().includes(needle)
      );
    });
  }, [users, query, roleFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageUsers = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  async function onCreateUser() {
    setUserBusy("create");
    setUsersMessage(null);
    setError(null);
    try {
      await createAdminUser(
        { username: newUsername.trim(), password: newPassword, role: newRole },
        me.csrfToken,
      );
      setNewUsername("");
      setNewPassword("");
      setNewRole("user");
      await loadUsers();
      setUsersMessage("User created.");
    } catch (err) {
      setError(userErrorMessage(err, "Unable to create user."));
    } finally {
      setUserBusy(null);
    }
  }

  async function onChangeRole(user: AdminLocalUser, role: Role) {
    if (user.role === role) return;
    setUserBusy(`role:${user.username}`);
    setUsersMessage(null);
    setError(null);
    try {
      await updateAdminUser(user.username, { role }, me.csrfToken);
      await loadUsers();
      setUsersMessage(`Updated role for ${user.username}.`);
    } catch (err) {
      setError(userErrorMessage(err, "Unable to update role."));
    } finally {
      setUserBusy(null);
    }
  }

  async function onResetPassword(user: AdminLocalUser) {
    const password = window.prompt(`New password for ${user.username}`);
    if (password === null) return;
    if (!password) {
      setError("Password is required.");
      return;
    }
    setUserBusy(`password:${user.username}`);
    setUsersMessage(null);
    setError(null);
    try {
      await updateAdminUser(user.username, { password }, me.csrfToken);
      await loadUsers();
      setUsersMessage(`Password updated for ${user.username}.`);
    } catch (err) {
      setError(userErrorMessage(err, "Unable to update password."));
    } finally {
      setUserBusy(null);
    }
  }

  async function onDeleteUser(user: AdminLocalUser) {
    if (user.username === me.username) {
      setError("You cannot delete your own account while signed in.");
      return;
    }
    const confirmed = window.confirm(
      `Delete local user ${user.username}? Their portal sessions end and any browser container is destroyed.`,
    );
    if (!confirmed) return;
    setUserBusy(`delete:${user.username}`);
    setUsersMessage(null);
    setError(null);
    try {
      await deleteAdminUser(user.username, me.csrfToken);
      await loadUsers();
      setUsersMessage(`Deleted ${user.username}.`);
    } catch (err) {
      setError(userErrorMessage(err, "Unable to delete user."));
    } finally {
      setUserBusy(null);
    }
  }

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>Users</h1>
          <p className="hint">
            Local accounts for password login and break-glass access. SSO users are not listed here.
          </p>
        </div>
        {users ? <span className="session-pill idle">{users.length} user(s)</span> : null}
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {usersMessage ? <p className="settings-saved">{usersMessage}</p> : null}

      <form
        className="admin-create"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreateUser();
        }}
      >
        <label>
          Username
          <input
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value)}
            autoComplete="off"
            required
            maxLength={64}
            disabled={userBusy !== null}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            required
            maxLength={256}
            disabled={userBusy !== null}
          />
        </label>
        <label>
          Role
          <select
            value={newRole}
            onChange={(event) => setNewRole(event.target.value as Role)}
            disabled={userBusy !== null}
          >
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <button type="submit" disabled={userBusy !== null}>
          {userBusy === "create" ? "Creating…" : "Add user"}
        </button>
      </form>

      {users ? (
        <>
          <div className="admin-toolbar">
            <input
              type="text"
              className="admin-search"
              placeholder="Search users"
              aria-label="Search users"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
            <select
              aria-label="Filter by role"
              value={roleFilter}
              onChange={(event) => {
                setRoleFilter(event.target.value as "all" | Role);
                setPage(0);
              }}
            >
              <option value="all">All roles</option>
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </select>
            <span className="hint admin-toolbar-count">
              {filtered.length === 0
                ? "0 users"
                : `${pageStart + 1}–${pageStart + pageUsers.length} of ${filtered.length}`}
            </span>
            <div className="admin-pager">
              <button
                type="button"
                className="button-quiet"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Prev
              </button>
              <span className="hint">
                Page {currentPage + 1} / {pageCount}
              </span>
              <button
                type="button"
                className="button-quiet"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Profile storage</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageUsers.length === 0 ? (
                  <tr>
                    <td className="empty" colSpan={5}>
                      {users.length === 0 ? "No local users yet." : "No users match your filters."}
                    </td>
                  </tr>
                ) : (
                  pageUsers.map((user) => {
                    const busy = userBusy !== null;
                    const stored = usageFor(user);
                    return (
                      <tr key={user.username}>
                        <td>
                          {user.username}
                          {user.username === me.username ? (
                            <span className="settings-tag muted">you</span>
                          ) : null}
                        </td>
                        <td>
                          <select
                            value={user.role}
                            disabled={busy}
                            onChange={(event) =>
                              void onChangeRole(user, event.target.value as Role)
                            }
                          >
                            <option value="user">User</option>
                            <option value="admin">Administrator</option>
                          </select>
                        </td>
                        <td>
                          {stored
                            ? `${formatBytes(stored.sizeBytes)} · ${stored.volumeCount} vol`
                            : "—"}
                        </td>
                        <td>{formatTime(user.createdAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="button-quiet"
                              disabled={busy}
                              onClick={() => void onResetPassword(user)}
                            >
                              Reset password
                            </button>
                            <button
                              type="button"
                              className="button-quiet danger"
                              disabled={busy || user.username === me.username}
                              onClick={() => void onDeleteUser(user)}
                            >
                              Delete
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
          <span className="loading-line" aria-hidden="true" /> Loading users…
        </p>
      )}
    </section>
  );
}
