import bcrypt from "bcrypt";
import type Database from "better-sqlite3";
import { localSubjectId } from "./identity";
import { isRole, type Role } from "./provider";
import { parseAuthUsers } from "./local-provider";

const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

export type LocalUserRecord = {
  username: string;
  role: Role;
  subjectId: string;
  createdAt: number;
  updatedAt: number;
};

type UserRow = {
  username: string;
  password_hash: string;
  role: string;
  subject_id: string;
  created_at: number;
  updated_at: number;
};

export type LocalUserStore = {
  count(): number;
  list(): LocalUserRecord[];
  get(username: string): LocalUserRecord | null;
  getAuthRecord(username: string): { role: Role; passwordHash: string; subjectId: string } | null;
  create(input: { username: string; password: string; role: Role }, rounds: number): Promise<LocalUserRecord>;
  setRole(username: string, role: Role): LocalUserRecord;
  setPassword(username: string, password: string, rounds: number): Promise<LocalUserRecord>;
  delete(username: string): boolean;
  countAdmins(): number;
};

function assertUsername(username: string): string {
  const value = username.trim();
  if (!USERNAME.test(value)) {
    throw Object.assign(new Error("invalid_username"), { statusCode: 400 });
  }
  return value;
}

function assertPassword(password: string): string {
  if (!password || password.length < 1 || password.length > 256) {
    throw Object.assign(new Error("invalid_password"), { statusCode: 400 });
  }
  return password;
}

function rowToUser(row: UserRow): LocalUserRecord {
  if (!isRole(row.role)) {
    throw new Error(`Invalid role stored for ${row.username}`);
  }
  return {
    username: row.username,
    role: row.role,
    subjectId: row.subject_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLocalUserStore(db: Database.Database): LocalUserStore {
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM local_users`);
  const listStmt = db.prepare<[], UserRow>(
    `SELECT username, password_hash, role, subject_id, created_at, updated_at
     FROM local_users ORDER BY username COLLATE NOCASE`,
  );
  const getStmt = db.prepare<[string], UserRow>(
    `SELECT username, password_hash, role, subject_id, created_at, updated_at
     FROM local_users WHERE username = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO local_users (username, password_hash, role, subject_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateRoleStmt = db.prepare(
    `UPDATE local_users SET role = ?, updated_at = ? WHERE username = ?`,
  );
  const updatePasswordStmt = db.prepare(
    `UPDATE local_users SET password_hash = ?, updated_at = ? WHERE username = ?`,
  );
  const deleteStmt = db.prepare(`DELETE FROM local_users WHERE username = ?`);
  const adminCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM local_users WHERE role = 'admin'`,
  );

  return {
    count() {
      return Number((countStmt.get() as { n: number }).n);
    },

    list() {
      return listStmt.all().map(rowToUser);
    },

    get(username) {
      const row = getStmt.get(username);
      return row ? rowToUser(row) : null;
    },

    getAuthRecord(username) {
      const row = getStmt.get(username);
      if (!row || !isRole(row.role)) return null;
      return {
        role: row.role,
        passwordHash: row.password_hash,
        subjectId: row.subject_id,
      };
    },

    async create(input, rounds) {
      const username = assertUsername(input.username);
      const password = assertPassword(input.password);
      if (!isRole(input.role)) {
        throw Object.assign(new Error("invalid_role"), { statusCode: 400 });
      }
      if (getStmt.get(username)) {
        throw Object.assign(new Error("username_taken"), { statusCode: 409 });
      }
      const now = Date.now();
      const passwordHash = await bcrypt.hash(password, rounds);
      const subjectId = localSubjectId(username);
      insertStmt.run(username, passwordHash, input.role, subjectId, now, now);
      return {
        username,
        role: input.role,
        subjectId,
        createdAt: now,
        updatedAt: now,
      };
    },

    setRole(username, role) {
      if (!isRole(role)) {
        throw Object.assign(new Error("invalid_role"), { statusCode: 400 });
      }
      const existing = getStmt.get(username);
      if (!existing || !isRole(existing.role)) {
        throw Object.assign(new Error("not_found"), { statusCode: 404 });
      }
      if (existing.role === "admin" && role !== "admin") {
        const admins = Number((adminCountStmt.get() as { n: number }).n);
        if (admins <= 1) {
          throw Object.assign(new Error("last_admin"), { statusCode: 400 });
        }
      }
      const now = Date.now();
      updateRoleStmt.run(role, now, username);
      return rowToUser({ ...existing, role, updated_at: now });
    },

    async setPassword(username, password, rounds) {
      const existing = getStmt.get(username);
      if (!existing) {
        throw Object.assign(new Error("not_found"), { statusCode: 404 });
      }
      const nextPassword = assertPassword(password);
      const now = Date.now();
      const passwordHash = await bcrypt.hash(nextPassword, rounds);
      updatePasswordStmt.run(passwordHash, now, username);
      return rowToUser({ ...existing, password_hash: passwordHash, updated_at: now });
    },

    delete(username) {
      const existing = getStmt.get(username);
      if (!existing || !isRole(existing.role)) return false;
      if (existing.role === "admin") {
        const admins = Number((adminCountStmt.get() as { n: number }).n);
        if (admins <= 1) {
          throw Object.assign(new Error("last_admin"), { statusCode: 400 });
        }
      }
      deleteStmt.run(username);
      return true;
    },

    countAdmins() {
      return Number((adminCountStmt.get() as { n: number }).n);
    },
  };
}

/** Seed local_users from AUTH_USERS when the table is empty (bootstrap only). */
export async function seedLocalUsersIfEmpty(
  store: LocalUserStore,
  authUsersSpec: string,
  rounds: number,
): Promise<number> {
  if (store.count() > 0) return 0;
  const spec = authUsersSpec.trim();
  if (!spec) {
    throw new Error(
      "No local users exist yet. Set AUTH_USERS in .env to bootstrap the first accounts.",
    );
  }
  const parsed = parseAuthUsers(spec);
  for (const user of parsed) {
    await store.create(
      { username: user.username, password: user.password, role: user.role },
      rounds,
    );
  }
  return parsed.length;
}
