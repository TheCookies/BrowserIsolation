"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLocalUserStore = createLocalUserStore;
exports.seedLocalUsersIfEmpty = seedLocalUsersIfEmpty;
const bcrypt_1 = __importDefault(require("bcrypt"));
const identity_1 = require("./identity");
const provider_1 = require("./provider");
const local_provider_1 = require("./local-provider");
const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;
function assertUsername(username) {
    const value = username.trim();
    if (!USERNAME.test(value)) {
        throw Object.assign(new Error("invalid_username"), { statusCode: 400 });
    }
    return value;
}
function assertPassword(password) {
    if (!password || password.length < 1 || password.length > 256) {
        throw Object.assign(new Error("invalid_password"), { statusCode: 400 });
    }
    return password;
}
function rowToUser(row) {
    if (!(0, provider_1.isRole)(row.role)) {
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
function createLocalUserStore(db) {
    const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM local_users`);
    const listStmt = db.prepare(`SELECT username, password_hash, role, subject_id, created_at, updated_at
     FROM local_users ORDER BY username COLLATE NOCASE`);
    const getStmt = db.prepare(`SELECT username, password_hash, role, subject_id, created_at, updated_at
     FROM local_users WHERE username = ?`);
    const insertStmt = db.prepare(`INSERT INTO local_users (username, password_hash, role, subject_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`);
    const updateRoleStmt = db.prepare(`UPDATE local_users SET role = ?, updated_at = ? WHERE username = ?`);
    const updatePasswordStmt = db.prepare(`UPDATE local_users SET password_hash = ?, updated_at = ? WHERE username = ?`);
    const deleteStmt = db.prepare(`DELETE FROM local_users WHERE username = ?`);
    const adminCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM local_users WHERE role = 'admin'`);
    return {
        count() {
            return Number(countStmt.get().n);
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
            if (!row || !(0, provider_1.isRole)(row.role))
                return null;
            return {
                role: row.role,
                passwordHash: row.password_hash,
                subjectId: row.subject_id,
            };
        },
        async create(input, rounds) {
            const username = assertUsername(input.username);
            const password = assertPassword(input.password);
            if (!(0, provider_1.isRole)(input.role)) {
                throw Object.assign(new Error("invalid_role"), { statusCode: 400 });
            }
            if (getStmt.get(username)) {
                throw Object.assign(new Error("username_taken"), { statusCode: 409 });
            }
            const now = Date.now();
            const passwordHash = await bcrypt_1.default.hash(password, rounds);
            const subjectId = (0, identity_1.localSubjectId)(username);
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
            if (!(0, provider_1.isRole)(role)) {
                throw Object.assign(new Error("invalid_role"), { statusCode: 400 });
            }
            const existing = getStmt.get(username);
            if (!existing || !(0, provider_1.isRole)(existing.role)) {
                throw Object.assign(new Error("not_found"), { statusCode: 404 });
            }
            if (existing.role === "admin" && role !== "admin") {
                const admins = Number(adminCountStmt.get().n);
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
            const passwordHash = await bcrypt_1.default.hash(nextPassword, rounds);
            updatePasswordStmt.run(passwordHash, now, username);
            return rowToUser({ ...existing, password_hash: passwordHash, updated_at: now });
        },
        delete(username) {
            const existing = getStmt.get(username);
            if (!existing || !(0, provider_1.isRole)(existing.role))
                return false;
            if (existing.role === "admin") {
                const admins = Number(adminCountStmt.get().n);
                if (admins <= 1) {
                    throw Object.assign(new Error("last_admin"), { statusCode: 400 });
                }
            }
            deleteStmt.run(username);
            return true;
        },
        countAdmins() {
            return Number(adminCountStmt.get().n);
        },
    };
}
/** Seed local_users from AUTH_USERS when the table is empty (bootstrap only). */
async function seedLocalUsersIfEmpty(store, authUsersSpec, rounds) {
    if (store.count() > 0)
        return 0;
    const spec = authUsersSpec.trim();
    if (!spec) {
        throw new Error("No local users exist yet. Set AUTH_USERS in .env to bootstrap the first accounts.");
    }
    const parsed = (0, local_provider_1.parseAuthUsers)(spec);
    for (const user of parsed) {
        await store.create({ username: user.username, password: user.password, role: user.role }, rounds);
    }
    return parsed.length;
}
//# sourceMappingURL=local-user-store.js.map