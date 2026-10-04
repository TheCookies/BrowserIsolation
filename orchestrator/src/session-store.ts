import type Database from "better-sqlite3";
import { localSubjectId } from "./auth/identity";
import { isRole, type AuthenticatedUser, type Role } from "./auth/provider";
import { randomToken } from "./security";

export type PortalSession = {
  id: string;
  username: string;
  role: Role;
  subjectId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
};

type SessionRow = {
  id: string;
  username: string;
  role: string;
  subject_id: string | null;
  csrf_token: string;
  created_at: number;
  expires_at: number;
};

export type SessionStore = {
  create(user: AuthenticatedUser): PortalSession;
  get(id: string): PortalSession | null;
  delete(id: string): void;
  deleteForUsername(username: string): number;
  updateRoleForUsername(username: string, role: Role): number;
  deleteExpired(now?: number): void;
};

export function createSessionStore(
  db: Database.Database,
  ttlMsOrGetter: number | (() => number),
): SessionStore {
  const getTtlMs = typeof ttlMsOrGetter === "function" ? ttlMsOrGetter : () => ttlMsOrGetter;
  const insert = db.prepare(
    `INSERT INTO portal_sessions (id, username, role, subject_id, csrf_token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const select = db.prepare<[string], SessionRow>(
    `SELECT id, username, role, subject_id, csrf_token, created_at, expires_at
     FROM portal_sessions WHERE id = ?`,
  );
  const remove = db.prepare(`DELETE FROM portal_sessions WHERE id = ?`);
  const removeForUser = db.prepare(`DELETE FROM portal_sessions WHERE username = ?`);
  const updateRoleForUser = db.prepare(`UPDATE portal_sessions SET role = ? WHERE username = ?`);
  const removeExpired = db.prepare(`DELETE FROM portal_sessions WHERE expires_at <= ?`);

  return {
    create(user) {
      const now = Date.now();
      const session: PortalSession = {
        id: randomToken(),
        username: user.username,
        role: user.role,
        subjectId: user.subjectId,
        csrfToken: randomToken(),
        createdAt: now,
        expiresAt: now + getTtlMs(),
      };
      insert.run(
        session.id,
        session.username,
        session.role,
        session.subjectId,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
      );
      return session;
    },

    get(id) {
      const row = select.get(id);
      if (!row) return null;
      if (row.expires_at <= Date.now() || !isRole(row.role)) {
        remove.run(id);
        return null;
      }
      const subjectId = row.subject_id?.trim() || localSubjectId(row.username);
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        subjectId,
        csrfToken: row.csrf_token,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    },

    delete(id) {
      remove.run(id);
    },

    deleteForUsername(username) {
      const result = removeForUser.run(username);
      return Number(result.changes ?? 0);
    },

    updateRoleForUsername(username, role) {
      const result = updateRoleForUser.run(role, username);
      return Number(result.changes ?? 0);
    },

    deleteExpired(now = Date.now()) {
      removeExpired.run(now);
    },
  };
}
