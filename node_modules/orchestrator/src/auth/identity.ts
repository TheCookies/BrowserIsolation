import { createHash } from "node:crypto";

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
export function localSubjectId(username: string): string {
  return `local:${username}`;
}

export function samlSubjectId(nameId: string, nameIdFormat?: string): string {
  const id = nameId.trim();
  if (!id) throw new Error("SAML NameID is empty.");
  if (nameIdFormat?.trim()) {
    return `saml:${nameIdFormat.trim()}:${id}`;
  }
  return `saml:${id}`;
}

/** Docker volume / path segment derived from subjectId (hex, path-safe). */
export function profileStorageKey(subjectId: string): string {
  return createHash("sha256").update(subjectId, "utf8").digest("hex").slice(0, 32);
}

export function profileVolumeName(subjectId: string, browser: string): string {
  return `rbi-profile-${profileStorageKey(subjectId)}-${browser}`;
}

/** Parse `rbi-profile-<32-hex>-<browserId>` volume names. */
export function parseProfileVolumeName(
  volumeName: string,
): { subjectKey: string; browser: string } | null {
  const match = /^rbi-profile-([a-f0-9]{32})-(.+)$/.exec(volumeName);
  if (!match) return null;
  return { subjectKey: match[1]!, browser: match[2]! };
}
