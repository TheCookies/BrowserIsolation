import type Database from "better-sqlite3";
import type { BrowserType } from "./config";

export type BrowserSessionRecord = {
  id: string;
  ownerUsername: string;
  /** Stable ownership id (local:… / ldap:… / saml:…). Unique session key. */
  ownerSubjectId: string;
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
  owner_subject_id: string;
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
    ownerSubjectId: row.owner_subject_id,
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
  getBySubjectId(subjectId: string): BrowserSessionRecord | null;
  list(): BrowserSessionRecord[];
  touch(id: string, at?: number): void;
  updateContainer(
    id: string,
    patch: { containerId: string; containerName: string },
  ): void;
  delete(id: string): void;
  deleteByOwner(username: string): BrowserSessionRecord | null;
  deleteBySubjectId(subjectId: string): BrowserSessionRecord | null;
  countByWorker(workerId: string): number;
  /**
   * Take a per-user launch slot before Docker starts. Different subjects each
   * get a port; the same subject joins the launch already in progress.
   */
  reserveLaunch(input: {
    subjectId: string;
    workerId: string;
    sessionId: string;
    /** Local worker: pick a free WebRTC port. Omit for remote workers. */
    portRange?: { start: number; end: number };
    /** Ports held outside this table (live containers, or a bind that just failed). */
    usedPorts?: number[];
  }): LaunchReservation;
  getLaunchClaim(subjectId: string): { sessionId: string } | null;
  commitLaunch(subjectId: string, record: BrowserSessionRecord): void;
  releaseLaunch(subjectId: string): void;
  clearLaunchClaims(): void;
};

export type LaunchReservation =
  | { status: "session"; session: BrowserSessionRecord }
  | { status: "busy"; sessionId: string }
  | { status: "reserved"; sessionId: string; webrtcPort: number };

const LAUNCH_CLAIM_TTL_MS = 3 * 60_000;

export function createBrowserSessionStore(db: Database.Database): BrowserSessionStore {
  const insert = db.prepare(`
    INSERT INTO browser_sessions (
      id, owner_username, owner_subject_id, browser, container_id, container_name,
      neko_admin_password, neko_user_password, webrtc_port, worker_id,
      created_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byId = db.prepare<[string], Row>(`SELECT * FROM browser_sessions WHERE id = ?`);
  const byOwner = db.prepare<[string], Row>(
    `SELECT * FROM browser_sessions WHERE owner_username = ?`,
  );
  const bySubject = db.prepare<[string], Row>(
    `SELECT * FROM browser_sessions WHERE owner_subject_id = ?`,
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
  const claimBySubject = db.prepare<
    [string],
    { session_id: string; created_at: number }
  >(`SELECT session_id, created_at FROM launch_claims WHERE subject_id = ?`);
  const deleteExpiredClaims = db.prepare(`DELETE FROM launch_claims WHERE created_at < ?`);
  const deleteClaim = db.prepare(`DELETE FROM launch_claims WHERE subject_id = ?`);
  const deleteAllClaims = db.prepare(`DELETE FROM launch_claims`);
  const insertClaim = db.prepare(
    `INSERT INTO launch_claims (subject_id, session_id, webrtc_port, worker_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const usedPorts = db.prepare<[string, string], { port: number }>(
    `SELECT webrtc_port AS port FROM browser_sessions WHERE worker_id = ?
     UNION
     SELECT webrtc_port AS port FROM launch_claims WHERE worker_id = ? AND webrtc_port > 0`,
  );

  const reserveLaunchTx = db.transaction(
    (input: {
      subjectId: string;
      workerId: string;
      sessionId: string;
      portRange?: { start: number; end: number };
      usedPorts?: number[];
    }): LaunchReservation => {
      const now = Date.now();
      deleteExpiredClaims.run(now - LAUNCH_CLAIM_TTL_MS);

      const existing = bySubject.get(input.subjectId);
      if (existing) return { status: "session", session: mapRow(existing) };

      const claim = claimBySubject.get(input.subjectId);
      if (claim) return { status: "busy", sessionId: claim.session_id };

      let port = 0;
      if (input.portRange) {
        const used = new Set(
          usedPorts.all(input.workerId, input.workerId).map((row) => row.port),
        );
        for (const port of input.usedPorts ?? []) used.add(port);
        let found = false;
        for (let candidate = input.portRange.start; candidate <= input.portRange.end; candidate += 1) {
          if (!used.has(candidate)) {
            port = candidate;
            found = true;
            break;
          }
        }
        if (!found) throw new Error("webrtc_port_pool_exhausted");
      }

      insertClaim.run(input.subjectId, input.sessionId, port, input.workerId, now);
      return { status: "reserved", sessionId: input.sessionId, webrtcPort: port };
    },
  );

  const commitLaunchTx = db.transaction((subjectId: string, record: BrowserSessionRecord) => {
    deleteClaim.run(subjectId);
    insert.run(
      record.id,
      record.ownerUsername,
      record.ownerSubjectId,
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
  });

  return {
    insert(record) {
      insert.run(
        record.id,
        record.ownerUsername,
        record.ownerSubjectId,
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

    getBySubjectId(subjectId) {
      const row = bySubject.get(subjectId);
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

    deleteBySubjectId(subjectId) {
      const existing = this.getBySubjectId(subjectId);
      if (!existing) return null;
      remove.run(existing.id);
      return existing;
    },

    countByWorker(workerId) {
      return countWorker.get(workerId)?.n ?? 0;
    },

    reserveLaunch(input) {
      return reserveLaunchTx(input);
    },

    getLaunchClaim(subjectId) {
      const claim = claimBySubject.get(subjectId);
      return claim ? { sessionId: claim.session_id } : null;
    },

    commitLaunch(subjectId, record) {
      commitLaunchTx(subjectId, record);
    },

    releaseLaunch(subjectId) {
      deleteClaim.run(subjectId);
    },

    clearLaunchClaims() {
      deleteAllClaims.run();
    },
  };
}
