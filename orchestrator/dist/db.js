"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openDatabase = openDatabase;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const neko_browsers_1 = require("./neko-browsers");
function recreateBrowserSessionsWithoutBrowserCheck(db) {
    const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_sessions'`)
        .get();
    if (!row?.sql)
        return;
    // Drop the hard-coded chrome/firefox/brave check so the Neko catalog can grow.
    if (!row.sql.includes("CHECK (browser IN"))
        return;
    db.exec(`
    BEGIN;
    CREATE TABLE browser_sessions_new (
      id TEXT PRIMARY KEY,
      owner_username TEXT NOT NULL UNIQUE,
      browser TEXT NOT NULL,
      container_id TEXT NOT NULL UNIQUE,
      container_name TEXT NOT NULL UNIQUE,
      neko_admin_password TEXT NOT NULL,
      neko_user_password TEXT NOT NULL,
      webrtc_port INTEGER NOT NULL,
      worker_id TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );
    INSERT INTO browser_sessions_new (
      id, owner_username, browser, container_id, container_name,
      neko_admin_password, neko_user_password, webrtc_port, worker_id, created_at, last_activity_at
    )
    SELECT
      id, owner_username, browser, container_id, container_name,
      neko_admin_password, neko_user_password, webrtc_port,
      'local', created_at, last_activity_at
    FROM browser_sessions;
    DROP TABLE browser_sessions;
    ALTER TABLE browser_sessions_new RENAME TO browser_sessions;
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_owner
      ON browser_sessions(owner_username);
    COMMIT;
  `);
}
function migrateLegacyChromeBrowserId(db) {
    db.prepare(`UPDATE browser_sessions SET browser = 'google-chrome' WHERE browser = 'chrome'`).run();
}
function migrateEnabledBrowsersAlias(db) {
    const row = db
        .prepare(`SELECT value FROM app_settings WHERE key = 'ENABLED_BROWSERS'`)
        .get();
    if (!row?.value)
        return;
    const parts = row.value
        .split(",")
        .map((part) => (0, neko_browsers_1.normalizeBrowserId)(part))
        .filter((id) => Boolean(id));
    const unique = [...new Set(parts)];
    if (unique.length === 0)
        return;
    const next = unique.join(",");
    if (next === row.value)
        return;
    db.prepare(`UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'ENABLED_BROWSERS'`).run(next, Date.now());
}
function openDatabase(filePath) {
    (0, node_fs_1.mkdirSync)(node_path_1.default.dirname(filePath), { recursive: true });
    const db = new better_sqlite3_1.default(filePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(`
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      subject_id TEXT NOT NULL DEFAULT '',
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      subject_id TEXT PRIMARY KEY,
      persist_profile INTEGER NOT NULL DEFAULT 0 CHECK (persist_profile IN (0, 1)),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      subject_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY,
      owner_username TEXT NOT NULL UNIQUE,
      browser TEXT NOT NULL,
      container_id TEXT NOT NULL UNIQUE,
      container_name TEXT NOT NULL UNIQUE,
      neko_admin_password TEXT NOT NULL,
      neko_user_password TEXT NOT NULL,
      webrtc_port INTEGER NOT NULL,
      worker_id TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_browser_sessions_owner
      ON browser_sessions(owner_username);

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL DEFAULT '',
      public_ip TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
      last_seen_at INTEGER,
      active_sessions INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS profile_placements (
      subject_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_id, browser)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_username TEXT NOT NULL,
      action TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      owner_username TEXT NOT NULL DEFAULT '',
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_created
      ON audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor
      ON audit_events(actor_username);
    CREATE INDEX IF NOT EXISTS idx_audit_events_action
      ON audit_events(action);
  `);
    recreateBrowserSessionsWithoutBrowserCheck(db);
    migrateLegacyChromeBrowserId(db);
    migrateEnabledBrowsersAlias(db);
    migratePortalSessionsSubjectId(db);
    migrateBrowserSessionWorkers(db);
    migrateAuditEventsWidenActions(db);
    migrateAuditEventsFilterIndexes(db);
    return db;
}
function migrateAuditEventsFilterIndexes(db) {
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor
      ON audit_events(actor_username);
    CREATE INDEX IF NOT EXISTS idx_audit_events_action
      ON audit_events(action);
  `);
}
/** Drop the old join/terminate-only CHECK so new admin actions can be stored. */
function migrateAuditEventsWidenActions(db) {
    const sqlRow = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'`)
        .get();
    if (!sqlRow?.sql?.includes("CHECK (action IN"))
        return;
    db.exec(`
    BEGIN;
    CREATE TABLE audit_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_username TEXT NOT NULL,
      action TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      owner_username TEXT NOT NULL DEFAULT '',
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO audit_events_new (
      id, actor_username, action, session_id, owner_username, detail, created_at
    )
    SELECT id, actor_username, action, session_id, owner_username, detail, created_at
    FROM audit_events;
    DROP TABLE audit_events;
    ALTER TABLE audit_events_new RENAME TO audit_events;
    CREATE INDEX IF NOT EXISTS idx_audit_events_created
      ON audit_events(created_at DESC);
    COMMIT;
  `);
}
function migrateBrowserSessionWorkers(db) {
    const cols = db.prepare(`PRAGMA table_info(browser_sessions)`).all();
    if (!cols.some((col) => col.name === "worker_id")) {
        db.exec(`ALTER TABLE browser_sessions ADD COLUMN worker_id TEXT NOT NULL DEFAULT 'local'`);
    }
    // Drop global UNIQUE(webrtc_port) so the same port may exist on different workers.
    const sqlRow = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_sessions'`)
        .get();
    if (sqlRow?.sql?.includes("webrtc_port INTEGER NOT NULL UNIQUE")) {
        db.exec(`
      BEGIN;
      CREATE TABLE browser_sessions_ports (
        id TEXT PRIMARY KEY,
        owner_username TEXT NOT NULL UNIQUE,
        browser TEXT NOT NULL,
        container_id TEXT NOT NULL UNIQUE,
        container_name TEXT NOT NULL UNIQUE,
        neko_admin_password TEXT NOT NULL,
        neko_user_password TEXT NOT NULL,
        webrtc_port INTEGER NOT NULL,
        worker_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
      INSERT INTO browser_sessions_ports (
        id, owner_username, browser, container_id, container_name,
        neko_admin_password, neko_user_password, webrtc_port, worker_id,
        created_at, last_activity_at
      )
      SELECT
        id, owner_username, browser, container_id, container_name,
        neko_admin_password, neko_user_password, webrtc_port,
        COALESCE(worker_id, 'local'), created_at, last_activity_at
      FROM browser_sessions;
      DROP TABLE browser_sessions;
      ALTER TABLE browser_sessions_ports RENAME TO browser_sessions;
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_owner
        ON browser_sessions(owner_username);
      COMMIT;
    `);
    }
}
function migratePortalSessionsSubjectId(db) {
    const cols = db.prepare(`PRAGMA table_info(portal_sessions)`).all();
    if (cols.some((col) => col.name === "subject_id"))
        return;
    db.exec(`ALTER TABLE portal_sessions ADD COLUMN subject_id TEXT NOT NULL DEFAULT ''`);
}
//# sourceMappingURL=db.js.map