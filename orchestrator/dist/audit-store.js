"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIT_ACTIONS = void 0;
exports.createAuditStore = createAuditStore;
/** Every mutating admin action that should appear in the audit log. */
exports.AUDIT_ACTIONS = [
    "join",
    "terminate",
    "update_settings",
    "create_user",
    "update_user_role",
    "reset_user_password",
    "delete_user",
    "create_worker",
    "enable_worker",
    "disable_worker",
    "delete_worker",
    "delete_volume",
    "update_browsers",
    "pull_browsers",
    "saml_login",
];
function mapRow(row) {
    return {
        id: row.id,
        actorUsername: row.actor_username,
        action: row.action,
        sessionId: row.session_id,
        ownerUsername: row.owner_username,
        detail: row.detail,
        createdAt: row.created_at,
    };
}
function createAuditStore(db) {
    const insert = db.prepare(`
    INSERT INTO audit_events (
      actor_username, action, session_id, owner_username, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
    const listStmt = db.prepare(`SELECT * FROM audit_events ORDER BY id DESC LIMIT ?`);
    return {
        record(input) {
            const at = input.at ?? Date.now();
            const sessionId = input.sessionId ?? "";
            const ownerUsername = input.ownerUsername ?? "";
            const result = insert.run(input.actorUsername, input.action, sessionId, ownerUsername, input.detail ?? null, at);
            return {
                id: Number(result.lastInsertRowid),
                actorUsername: input.actorUsername,
                action: input.action,
                sessionId,
                ownerUsername,
                detail: input.detail ?? null,
                createdAt: at,
            };
        },
        list(limit = 200) {
            const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
            return listStmt.all(capped).map(mapRow);
        },
    };
}
//# sourceMappingURL=audit-store.js.map