import type Database from "better-sqlite3";
import type { WorkerRecord } from "./types";

type Row = {
  id: string;
  base_url: string;
  public_ip: string;
  token: string;
  enabled: number;
  kind: string;
  last_seen_at: number | null;
  active_sessions: number;
};

function mapRow(row: Row): WorkerRecord {
  return {
    id: row.id,
    baseUrl: row.base_url,
    publicIp: row.public_ip,
    token: row.token,
    enabled: row.enabled === 1,
    kind: row.kind === "local" ? "local" : "remote",
    lastSeenAt: row.last_seen_at,
    activeSessions: row.active_sessions,
  };
}

export type WorkerStore = {
  list(): WorkerRecord[];
  get(id: string): WorkerRecord | null;
  upsert(record: Omit<WorkerRecord, "lastSeenAt" | "activeSessions"> & {
    lastSeenAt?: number | null;
    activeSessions?: number;
  }): WorkerRecord;
  setEnabled(id: string, enabled: boolean): WorkerRecord | null;
  touchStatus(id: string, patch: { lastSeenAt: number; activeSessions: number; publicIp?: string }): void;
  delete(id: string): boolean;
  /** Last worker that hosted a persistent profile for subject+browser. */
  getProfilePlacement(subjectId: string, browser: string): string | null;
  setProfilePlacement(subjectId: string, browser: string, workerId: string): void;
  clearProfilePlacement(subjectId: string, browser: string): void;
};

export function createWorkerStore(db: Database.Database): WorkerStore {
  const selectAll = db.prepare<[], Row>(`SELECT * FROM workers ORDER BY kind ASC, id ASC`);
  const selectOne = db.prepare<[string], Row>(`SELECT * FROM workers WHERE id = ?`);
  const upsert = db.prepare(`
    INSERT INTO workers (id, base_url, public_ip, token, enabled, kind, last_seen_at, active_sessions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      public_ip = excluded.public_ip,
      token = excluded.token,
      enabled = excluded.enabled,
      kind = excluded.kind
  `);
  const setEnabledStmt = db.prepare(`UPDATE workers SET enabled = ? WHERE id = ?`);
  const touchStmt = db.prepare(`
    UPDATE workers SET last_seen_at = ?, active_sessions = ?, public_ip = COALESCE(?, public_ip)
    WHERE id = ?
  `);
  const remove = db.prepare(`DELETE FROM workers WHERE id = ?`);
  const getPlacement = db.prepare<[string, string], { worker_id: string }>(
    `SELECT worker_id FROM profile_placements WHERE subject_id = ? AND browser = ?`,
  );
  const upsertPlacement = db.prepare(`
    INSERT INTO profile_placements (subject_id, browser, worker_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_id, browser) DO UPDATE SET
      worker_id = excluded.worker_id,
      updated_at = excluded.updated_at
  `);
  const deletePlacement = db.prepare(
    `DELETE FROM profile_placements WHERE subject_id = ? AND browser = ?`,
  );

  return {
    list() {
      return selectAll.all().map(mapRow);
    },

    get(id) {
      const row = selectOne.get(id);
      return row ? mapRow(row) : null;
    },

    upsert(record) {
      upsert.run(
        record.id,
        record.baseUrl,
        record.publicIp,
        record.token,
        record.enabled ? 1 : 0,
        record.kind,
        record.lastSeenAt ?? null,
        record.activeSessions ?? 0,
      );
      return this.get(record.id)!;
    },

    setEnabled(id, enabled) {
      const result = setEnabledStmt.run(enabled ? 1 : 0, id);
      if (result.changes === 0) return null;
      return this.get(id);
    },

    touchStatus(id, patch) {
      touchStmt.run(patch.lastSeenAt, patch.activeSessions, patch.publicIp ?? null, id);
    },

    delete(id) {
      const row = this.get(id);
      if (!row || row.kind === "local") return false;
      remove.run(id);
      return true;
    },

    getProfilePlacement(subjectId, browser) {
      return getPlacement.get(subjectId, browser)?.worker_id ?? null;
    },

    setProfilePlacement(subjectId, browser, workerId) {
      upsertPlacement.run(subjectId, browser, workerId, Date.now());
    },

    clearProfilePlacement(subjectId, browser) {
      deletePlacement.run(subjectId, browser);
    },
  };
}

/** Parse WORKERS=id|url|publicIp|token,id2|url2|ip2|token2 */
export function parseWorkersEnv(raw: string | undefined): Array<{
  id: string;
  baseUrl: string;
  publicIp: string;
  token: string;
}> {
  if (!raw?.trim()) return [];
  const out: Array<{ id: string; baseUrl: string; publicIp: string; token: string }> = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [id, baseUrl, publicIp, token] = trimmed.split("|").map((item) => item.trim());
    if (!id || !baseUrl || !publicIp || !token) {
      throw new Error(
        `WORKERS entry must be id|baseUrl|publicIp|token (got ${trimmed.slice(0, 80)})`,
      );
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`WORKERS baseUrl must be absolute http(s) URL for ${id}`);
    }
    out.push({ id, baseUrl: baseUrl.replace(/\/+$/, ""), publicIp, token });
  }
  return out;
}
