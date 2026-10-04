"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSessionStore = createSessionStore;
const identity_1 = require("./auth/identity");
const provider_1 = require("./auth/provider");
const security_1 = require("./security");
function createSessionStore(db, ttlMsOrGetter) {
    const getTtlMs = typeof ttlMsOrGetter === "function" ? ttlMsOrGetter : () => ttlMsOrGetter;
    const insert = db.prepare(`INSERT INTO portal_sessions (id, username, role, subject_id, csrf_token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const select = db.prepare(`SELECT id, username, role, subject_id, csrf_token, created_at, expires_at
     FROM portal_sessions WHERE id = ?`);
    const remove = db.prepare(`DELETE FROM portal_sessions WHERE id = ?`);
    const removeForUser = db.prepare(`DELETE FROM portal_sessions WHERE username = ?`);
    const updateRoleForUser = db.prepare(`UPDATE portal_sessions SET role = ? WHERE username = ?`);
    const removeExpired = db.prepare(`DELETE FROM portal_sessions WHERE expires_at <= ?`);
    return {
        create(user) {
            const now = Date.now();
            const session = {
                id: (0, security_1.randomToken)(),
                username: user.username,
                role: user.role,
                subjectId: user.subjectId,
                csrfToken: (0, security_1.randomToken)(),
                createdAt: now,
                expiresAt: now + getTtlMs(),
            };
            insert.run(session.id, session.username, session.role, session.subjectId, session.csrfToken, session.createdAt, session.expiresAt);
            return session;
        },
        get(id) {
            const row = select.get(id);
            if (!row)
                return null;
            if (row.expires_at <= Date.now() || !(0, provider_1.isRole)(row.role)) {
                remove.run(id);
                return null;
            }
            const subjectId = row.subject_id?.trim() || (0, identity_1.localSubjectId)(row.username);
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
//# sourceMappingURL=session-store.js.map