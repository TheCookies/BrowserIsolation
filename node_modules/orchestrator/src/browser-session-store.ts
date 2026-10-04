import type Database from "better-sqlite3";
import type { BrowserType } from "./config";

export type BrowserSessionRecord = {
  id: string;
  ownerUsername: string;
  browser: BrowserType;
  containerId: string;
  containerName: string;
  nekoAdminPassword: string;
  nekoUserPassword: string;
  webrtcPort: number;
  workerId: string;
  createdAt: number;
  lastActivityAt: number;
};

type Row = {
  id: string;
  owner_username: string;
  browser: string;
  container_id: string;
  container_name: string;
  neko_admin_password: string;
  neko_user_password: string;
  webrtc_port: number;
  worker_id: string;
  created_at: number;
  last_activity_at: number;
};

function mapRow(row: Row): BrowserSessionRecord {
  return {
    id: row.id,
    ownerUsername: row.owner_username,
    browser: row.browser as BrowserType,
    containerId: row.container_id,
    containerName: row.container_name,
    nekoAdminPassword: row.neko_admin_password,
    nekoUserPassword: row.neko_user_password,
    webrtcPort: row.webrtc_port,
    workerId: row.worker_id || "local",
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

export type BrowserSessionStore = {
  insert(record: BrowserSessionRecord): void;
  getById(id: string): BrowserSessionRecord | null;
  getByOwner(username: string): BrowserSessionRecord | null;
  list(): BrowserSessionRecord[];
  touch(id: string, at?: number): void;
  updateContainer(
    id: string,
    patch: { containerId: string; containerName: string },
  ): void;
  delete(id: string): void;
  deleteByOwner(username: string): BrowserSessionRecord | null;
  countByWorker(workerId: string): number;
};

export function createBrowserSessionStore(db: Database.Database): BrowserSessionStore {
  const insert = db.prepare(`
    INSERT INTO browser_sessions (
      id, owner_username, browser, container_id, container_name,
      neko_admin_password, neko_user_password, webrtc_port, worker_id,
      created_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byId = db.prepare<[string], Row>(`SELECT * FROM browser_sessions WHERE id = ?`);
  const byOwner = db.prepare<[string], Row>(
    `SELECT * FROM browser_sessions WHERE owner_username = ?`,
  );
  const all = db.prepare<[], Row>(`SELECT * FROM browser_sessions ORDER BY created_at DESC`);
  const touchStmt = db.prepare(`UPDATE browser_sessions SET last_activity_at = ? WHERE id = ?`);
  const updateContainerStmt = db.prepare(
    `UPDATE browser_sessions SET container_id = ?, container_name = ? WHERE id = ?`,
  );
  const remove = db.prepare(`DELETE FROM browser_sessions WHERE id = ?`);
  const countWorker = db.prepare<[string], { n: number }>(
    `SELECT COUNT(*) AS n FROM browser_sessions WHERE worker_id = ?`,
  );

  return {
    insert(record) {
      insert.run(
        record.id,
        record.ownerUsername,
        record.browser,
        record.containerId,
        record.containerName,
        record.nekoAdminPassword,
        record.nekoUserPassword,
        record.webrtcPort,
        record.workerId,
        record.createdAt,
        record.lastActivityAt,
      );
    },

    getById(id) {
      const row = byId.get(id);
      return row ? mapRow(row) : null;
    },

    getByOwner(username) {
      const row = byOwner.get(username);
      return row ? mapRow(row) : null;
    },

    list() {
      return all.all().map(mapRow);
    },

    touch(id, at = Date.now()) {
      touchStmt.run(at, id);
    },

    updateContainer(id, patch) {
      updateContainerStmt.run(patch.containerId, patch.containerName, id);
    },

    delete(id) {
      remove.run(id);
    },

    deleteByOwner(username) {
      const existing = this.getByOwner(username);
      if (!existing) return null;
      remove.run(existing.id);
      return existing;
    },

    countByWorker(workerId) {
      return countWorker.get(workerId)?.n ?? 0;
    },
  };
}
