"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.localSubjectId = localSubjectId;
exports.samlSubjectId = samlSubjectId;
exports.profileStorageKey = profileStorageKey;
exports.profileVolumeName = profileVolumeName;
exports.parseProfileVolumeName = parseProfileVolumeName;
const node_crypto_1 = require("node:crypto");
/**
 * Stable user identity for ownership of preferences and browser profile volumes.
 *
 * Format today (local auth): `local:<username>`
 * Planned SAML format:      `saml:<NameID>` (or `saml:<NameIDFormat>:<NameID>`)
 *
 * Never use display usernames alone as storage keys — SAML NameIDs and local
 * usernames can collide or contain path-unsafe characters. Always derive a
 * filesystem/volume key with `profileStorageKey(subjectId)`.
 *
 * See docs/USER_IDENTITY.md for the SAML swap checklist.
 */
function localSubjectId(username) {
    return `local:${username}`;
}
function samlSubjectId(nameId, nameIdFormat) {
    const id = nameId.trim();
    if (!id)
        throw new Error("SAML NameID is empty.");
    if (nameIdFormat?.trim()) {
        return `saml:${nameIdFormat.trim()}:${id}`;
    }
    return `saml:${id}`;
}
/** Docker volume / path segment derived from subjectId (hex, path-safe). */
function profileStorageKey(subjectId) {
    return (0, node_crypto_1.createHash)("sha256").update(subjectId, "utf8").digest("hex").slice(0, 32);
}
function profileVolumeName(subjectId, browser) {
    return `rbi-profile-${profileStorageKey(subjectId)}-${browser}`;
}
/** Parse `rbi-profile-<32-hex>-<browserId>` volume names. */
function parseProfileVolumeName(volumeName) {
    const match = /^rbi-profile-([a-f0-9]{32})-(.+)$/.exec(volumeName);
    if (!match)
        return null;
    return { subjectKey: match[1], browser: match[2] };
}
//# sourceMappingURL=identity.js.map