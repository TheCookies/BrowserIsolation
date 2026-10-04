"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAuthUsers = parseAuthUsers;
exports.hashAuthUsers = hashAuthUsers;
exports.createLocalAuthProvider = createLocalAuthProvider;
const bcrypt_1 = __importDefault(require("bcrypt"));
const provider_1 = require("./provider");
const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;
function parseAuthUsers(spec) {
    const entries = spec
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
        throw new Error("AUTH_USERS is empty. See .env.example.");
    }
    const users = [];
    const seen = new Set();
    for (const entry of entries) {
        const parts = entry.split(":");
        if (parts.length < 3) {
            throw new Error("AUTH_USERS entries must look like username:password:role.");
        }
        const username = parts[0]?.trim() ?? "";
        const roleText = parts[parts.length - 1]?.trim() ?? "";
        const password = parts.slice(1, -1).join(":").trim();
        if (!USERNAME.test(username)) {
            throw new Error(`AUTH_USERS username "${username}" is not allowed.`);
        }
        if (!password) {
            throw new Error(`AUTH_USERS password for "${username}" is empty.`);
        }
        if (!(0, provider_1.isRole)(roleText)) {
            throw new Error(`AUTH_USERS role for "${username}" must be user or admin.`);
        }
        if (seen.has(username)) {
            throw new Error(`AUTH_USERS lists "${username}" more than once.`);
        }
        seen.add(username);
        users.push({ username, password, role: roleText });
    }
    return users;
}
async function hashAuthUsers(spec, rounds) {
    const parsed = parseAuthUsers(spec);
    const records = new Map();
    for (const user of parsed) {
        records.set(user.username, {
            role: user.role,
            passwordHash: await bcrypt_1.default.hash(user.password, rounds),
        });
    }
    return records;
}
/** DB-backed local auth used by the portal (see docs/USER_IDENTITY.md). */
async function createLocalAuthProvider(users, rounds = 12) {
    const dummyHash = await bcrypt_1.default.hash("local-auth-dummy-password", rounds);
    return {
        async authenticate(username, password) {
            const record = users.getAuthRecord(username);
            const hash = record?.passwordHash ?? dummyHash;
            const matches = await bcrypt_1.default.compare(password, hash);
            if (!record || !matches)
                return null;
            return {
                username,
                role: record.role,
                subjectId: record.subjectId,
            };
        },
    };
}
//# sourceMappingURL=local-provider.js.map