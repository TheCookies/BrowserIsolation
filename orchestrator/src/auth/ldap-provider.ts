import { Client, Filter } from "ldapts";
import type { Config } from "../config";
import { ldapSubjectId } from "./identity";
import type { AuthProvider, AuthenticatedUser, Role } from "./provider";

export const DEFAULT_LDAP_SEARCH_FILTER =
  "(|(sAMAccountName={{username}})(userPrincipalName={{username}}))";
export const DEFAULT_LDAP_USERNAME_ATTR = "sAMAccountName";
export const DEFAULT_LDAP_GROUPS_ATTR = "memberOf";

export type LdapAttributeValue =
  | Buffer
  | Buffer[]
  | Uint8Array
  | string
  | string[]
  | number[];

export type LdapUserEntry = {
  dn: string;
  attributes: Record<string, LdapAttributeValue>;
};

/** Attributes that identify one directory account. objectGUID/objectSid are binary. */
const LDAP_IDENTITY_ATTRIBUTES = [
  "objectGUID",
  "objectSid",
  "entryUUID",
  "nsUniqueId",
  "distinguishedName",
] as const;

const LDAP_BINARY_ATTRIBUTES = [
  "objectGUID",
  "objectSid",
  "objectGUID;binary",
  "objectSid;binary",
];

/** Injectable directory operations for unit tests. */
export type LdapDirectory = {
  findUser(input: {
    username: string;
    config: Config;
  }): Promise<LdapUserEntry | null>;
  verifyPassword(input: {
    dn: string;
    password: string;
    config: Config;
  }): Promise<boolean>;
};

export function escapeLdapFilterValue(value: string): string {
  return Filter.escape(value);
}

/** Replace `{{username}}` with an RFC 4515-escaped value. */
export function buildLdapSearchFilter(template: string, username: string): string {
  const raw = (template.trim() || DEFAULT_LDAP_SEARCH_FILTER).replaceAll(
    "{{username}}",
    escapeLdapFilterValue(username.trim()),
  );
  if (!raw.trim()) {
    throw new Error("LDAP_SEARCH_FILTER must not be empty.");
  }
  return raw;
}

/**
 * Parse LDAP_ADMIN_GROUP. Semicolons always separate entries (needed for full
 * DNs that contain commas). Commas separate only simple CN/name lists that do
 * not contain `=`. A single DN string is kept intact.
 */
export function parseAdminGroups(spec: string): string[] {
  const trimmed = spec.trim();
  if (!trimmed) return [];
  if (trimmed.includes(";")) {
    return trimmed
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (/=/.test(trimmed)) {
    return [trimmed];
  }
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Extract CN=… from a DN when present. */
export function groupCn(value: string): string | null {
  const match = /(?:^|,)\s*CN=([^,]+)/i.exec(value);
  return match?.[1]?.trim() || null;
}

export function mapLdapRole(groups: string[], adminGroupSpec: string): Role {
  const needles = parseAdminGroups(adminGroupSpec).map((item) => item.toLowerCase());
  if (needles.length === 0) return "user";
  for (const group of groups) {
    const full = group.trim().toLowerCase();
    const cn = groupCn(group)?.toLowerCase() ?? "";
    if (needles.some((needle) => needle === full || (cn && needle === cn))) {
      return "admin";
    }
  }
  return "user";
}

function asStringList(value: LdapAttributeValue | undefined): string[] {
  if (value === undefined) return [];
  if (Buffer.isBuffer(value)) return [value.toString("utf8")];
  if (value instanceof Uint8Array) return [Buffer.from(value).toString("utf8")];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return asStringList(item);
      if (Buffer.isBuffer(item)) return asStringList(item);
      return [];
    });
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

/**
 * Copy binary directory values out of ldapts' socket buffer before unbind.
 * objectGUID/objectSid are views into that buffer; a later read can overwrite
 * them, which made every AD account look like the same user.
 */
export function snapshotLdapEntry(entry: LdapUserEntry): LdapUserEntry {
  const attributes: LdapUserEntry["attributes"] = {};
  for (const [key, value] of Object.entries(entry.attributes)) {
    const cloned = cloneLdapAttribute(value);
    if (cloned !== undefined) attributes[key] = cloned;
  }
  return { dn: String(entry.dn ?? ""), attributes };
}

function cloneLdapAttribute(value: unknown): LdapAttributeValue | undefined {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  if (
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Buffer.from(value);
  }
  const buffers: Buffer[] = [];
  const strings: string[] = [];
  for (const item of value) {
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) buffers.push(Buffer.from(item));
    else if (typeof item === "string") strings.push(item);
  }
  if (buffers.length > 0 && strings.length === 0) {
    return buffers.length === 1 ? buffers[0]! : buffers;
  }
  if (strings.length > 0) return strings.length === 1 ? strings[0]! : strings;
  return undefined;
}

/** Format AD objectGUID (16-byte little-endian) as a dashed GUID string. */
export function formatObjectGuid(raw: Buffer): string {
  if (raw.length !== 16) {
    return raw.toString("hex");
  }
  const d1 = raw.readUInt32LE(0).toString(16).padStart(8, "0");
  const d2 = raw.readUInt16LE(4).toString(16).padStart(4, "0");
  const d3 = raw.readUInt16LE(6).toString(16).padStart(4, "0");
  const d4 = raw.subarray(8, 10).toString("hex");
  const d5 = raw.subarray(10, 16).toString("hex");
  return `${d1}-${d2}-${d3}-${d4}-${d5}`;
}

export function resolveLdapDisplayUsername(
  entry: LdapUserEntry,
  usernameAttr: string,
  fallback: string,
): string {
  const attr = (usernameAttr.trim() || DEFAULT_LDAP_USERNAME_ATTR).toLowerCase();
  const key =
    Object.keys(entry.attributes).find((name) => name.toLowerCase() === attr) ??
    Object.keys(entry.attributes).find((name) => name.toLowerCase() === "samaccountname") ??
    Object.keys(entry.attributes).find((name) => name.toLowerCase() === "userprincipalname");
  const raw = key ? asStringList(entry.attributes[key])[0] : undefined;
  const candidate = (raw ?? fallback).trim();
  // Prefer the short account name so login as jsmith vs jsmith@domain stay one identity
  // for UI display. Session ownership uses subjectId separately.
  if (candidate.includes("@")) {
    const localPart = candidate.split("@")[0]?.trim();
    if (localPart) return localPart;
  }
  return candidate || fallback.trim();
}

export function resolveLdapGroups(entry: LdapUserEntry, groupsAttr: string): string[] {
  const attr = (groupsAttr.trim() || DEFAULT_LDAP_GROUPS_ATTR).toLowerCase();
  const key = Object.keys(entry.attributes).find((name) => name.toLowerCase() === attr);
  if (!key) return [];
  return asStringList(entry.attributes[key]);
}

<<<<<<< HEAD
function asObjectGuidBuffer(
  value: Buffer | Buffer[] | string | string[] | Uint8Array | undefined,
): Buffer | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  // Copy immediately. ldapts may reuse the underlying bytes across searches.
  if (Buffer.isBuffer(raw) && raw.length === 16) return Buffer.from(raw);
  if (raw instanceof Uint8Array && raw.length === 16) return Buffer.from(raw);
  return null;
}

/** True when a parsed GUID cannot distinguish directory users. */
function isUselessGuid(guid: string): boolean {
  const hex = guid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return true;
  return /^0+$/.test(hex) || /^(.)\1+$/.test(hex);
}

function readEntryDn(entry: LdapUserEntry): string {
  const direct = typeof entry.dn === "string" ? entry.dn.trim() : String(entry.dn ?? "").trim();
  if (direct && direct !== "[object Object]") return direct;
  const key = Object.keys(entry.attributes).find((name) => name.toLowerCase() === "distinguishedname");
  return (key ? asStringList(entry.attributes[key])[0] : "")?.trim() ?? "";
}

export function resolveLdapSubjectId(entry: LdapUserEntry): string {
  const dn = readEntryDn(entry);
  const guidKey = Object.keys(entry.attributes).find(
    (name) => name.toLowerCase() === "objectguid",
  );
  if (guidKey) {
    const raw = entry.attributes[guidKey];
    const buf = asObjectGuidBuffer(raw as Buffer | Buffer[] | string | string[] | undefined);
    if (buf) {
      const guid = formatObjectGuid(buf);
      // A shared or empty GUID would put every LDAP user on one browser.
      if (!isUselessGuid(guid)) return ldapSubjectId(guid);
    }
    const single = Array.isArray(raw) ? raw[0] : raw;
    if (typeof single === "string" && single.trim()) {
      const trimmed = single.trim();
      if (
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          trimmed,
        ) &&
        !isUselessGuid(trimmed)
      ) {
        return ldapSubjectId(trimmed.toLowerCase());
      }
    }
  }
  if (!dn) throw new Error("LDAP entry has no DN or objectGUID.");
  return ldapSubjectId(dn);
=======
const NIL_GUID = "00000000-0000-0000-0000-000000000000";
const DASHED_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function attributeByName(entry: LdapUserEntry, baseName: string): LdapAttributeValue | undefined {
  const want = baseName.toLowerCase();
  const key = Object.keys(entry.attributes).find((name) => {
    const lower = name.toLowerCase();
    return lower === want || lower.startsWith(`${want};`);
  });
  return key ? entry.attributes[key] : undefined;
}

/** ldapts fills requested-but-missing attributes with []. A byte list is one value. */
function firstAttributeValue(value: LdapAttributeValue | undefined): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 0) return undefined;
  if (value.every((item) => typeof item === "number")) return value;
  return value[0];
}

function guidFromBytes(raw: Buffer): string | null {
  if (raw.length !== 16) return null;
  const copy = Buffer.from(raw);
  if (copy.every((byte) => byte === copy[0])) return null;
  const formatted = formatObjectGuid(copy);
  return formatted === NIL_GUID ? null : formatted;
}

function readObjectGuid(entry: LdapUserEntry): string | null {
  const raw = firstAttributeValue(attributeByName(entry, "objectGUID"));
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return guidFromBytes(Buffer.from(raw));
  if (
    Array.isArray(raw) &&
    raw.length === 16 &&
    raw.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return guidFromBytes(Buffer.from(raw));
  }
  if (typeof raw !== "string" || !raw) return null;
  // Binary strings are not trimmed: a GUID byte can be whitespace.
  if (raw.length === 16) {
    const fromBinary = guidFromBytes(Buffer.from(raw, "latin1"));
    if (fromBinary) return fromBinary;
  }
  const trimmed = raw.trim().replace(/^\{([0-9a-fA-F-]{36})\}$/, "$1");
  if (DASHED_GUID.test(trimmed)) {
    const formatted = trimmed.toLowerCase();
    return formatted === NIL_GUID ? null : formatted;
  }
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return guidFromBytes(Buffer.from(trimmed, "hex"));
  if (/^[A-Za-z0-9+/]{22}={0,2}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) return guidFromBytes(decoded);
  }
  return null;
}

/** Active Directory objectSid → `S-1-5-21-…`. */
export function formatObjectSid(raw: Buffer): string | null {
  if (raw.length < 8) return null;
  const revision = raw[0] ?? 0;
  const count = raw[1] ?? 0;
  if (count > 15 || raw.length < 8 + count * 4) return null;
  let authority = 0n;
  for (let i = 2; i < 8; i += 1) {
    authority = (authority << 8n) + BigInt(raw[i] ?? 0);
  }
  const parts = [`S-${revision}-${authority.toString()}`];
  for (let i = 0; i < count; i += 1) {
    parts.push(String(raw.readUInt32LE(8 + i * 4)));
  }
  return parts.join("-");
}

function readObjectSid(entry: LdapUserEntry): string | null {
  const raw = firstAttributeValue(attributeByName(entry, "objectSid"));
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return formatObjectSid(Buffer.from(raw));
  if (typeof raw === "string" && /^S-\d+(-\d+)+$/i.test(raw.trim())) return raw.trim();
  return null;
}

function readDirectoryUuid(entry: LdapUserEntry): string | null {
  for (const name of ["entryUUID", "nsUniqueId"]) {
    const text = asStringList(attributeByName(entry, name))[0]?.trim() ?? "";
    if (text && text.toLowerCase() !== NIL_GUID) return text;
  }
  return null;
}

function directoryDn(entry: LdapUserEntry): string {
  const fromAttribute = asStringList(attributeByName(entry, "distinguishedName"))[0]?.trim() ?? "";
  if (fromAttribute.includes("=")) return fromAttribute;
  const direct = entry.dn?.trim() ?? "";
  return direct.includes("=") ? direct : "";
}

function normalizeDn(dn: string): string {
  return dn.trim().toLowerCase();
}

/**
 * One directory account → one subject. objectGUID/objectSid/entryUUID are tried
 * first, and the account DN is always included so two people cannot collapse
 * onto one id when a binary value is missing or was decoded the same way.
 * Display username is intentionally not part of this id.
 */
export function resolveLdapSubjectId(entry: LdapUserEntry): string {
  const dn = directoryDn(entry);
  const sid = readObjectSid(entry);
  const uuid = readDirectoryUuid(entry);
  const token = readObjectGuid(entry) ?? (sid ? `sid:${sid}` : null) ?? (uuid ? `uuid:${uuid}` : null);
  if (token && dn) return ldapSubjectId(`${token}|${normalizeDn(dn)}`);
  if (token) return ldapSubjectId(token);
  if (dn) return ldapSubjectId(dn);
  throw new Error("LDAP entry has no objectGUID, objectSid, entryUUID, or DN.");
>>>>>>> ef870ea69b70db550f60621a59b7ee50ec1a3b2e
}

export function entryToUser(
  entry: LdapUserEntry,
  loginUsername: string,
  config: Pick<Config, "ldapUsernameAttr" | "ldapGroupsAttr" | "ldapAdminGroup">,
): AuthenticatedUser {
  const safe = snapshotLdapEntry(entry);
  const username = resolveLdapDisplayUsername(safe, config.ldapUsernameAttr, loginUsername);
  const groups = resolveLdapGroups(safe, config.ldapGroupsAttr);
  return {
    username,
    role: mapLdapRole(groups, config.ldapAdminGroup),
    subjectId: resolveLdapSubjectId(safe),
  };
}

export type LdapReadinessItem = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type LdapTestStep = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type LdapTestResult = {
  ok: boolean;
  message: string;
  steps: LdapTestStep[];
};

/** Required fields for a usable LDAP connection (independent of LDAP_ENABLED). */
export function assertLdapConfigured(config: Config): void {
  const url = config.ldapUrl.trim();
  if (!url) throw new Error("LDAP_URL is required.");
  if (!/^ldaps?:\/\//i.test(url)) {
    throw new Error("LDAP_URL must be an ldap:// or ldaps:// URI.");
  }
  if (!config.ldapBindDn.trim()) {
    throw new Error("LDAP_BIND_DN is required.");
  }
  if (!config.ldapBindPassword) {
    throw new Error("LDAP_BIND_PASSWORD is required.");
  }
  if (!config.ldapSearchBase.trim()) {
    throw new Error("LDAP_SEARCH_BASE is required.");
  }
  const filter = config.ldapSearchFilter.trim();
  if (filter && !filter.includes("{{username}}")) {
    throw new Error('LDAP_SEARCH_FILTER must include "{{username}}".');
  }
}

/** Refuse to enable LDAP until connection settings are complete. */
export function assertLdapReady(config: Config): void {
  if (!config.ldapEnabled) return;
  assertLdapConfigured(config);
}

/** Checklist for the admin UI (draft or live values). */
export function describeLdapReadiness(
  config: Pick<
    Config,
    | "ldapEnabled"
    | "ldapUrl"
    | "ldapBindDn"
    | "ldapBindPassword"
    | "ldapSearchBase"
    | "ldapSearchFilter"
  >,
): { ready: boolean; items: LdapReadinessItem[] } {
  const filter = config.ldapSearchFilter.trim();
  const items: LdapReadinessItem[] = [
    {
      id: "url",
      label: "LDAP URL",
      ok: Boolean(config.ldapUrl.trim()) && /^ldaps?:\/\//i.test(config.ldapUrl.trim()),
      detail: config.ldapUrl.trim()
        ? /^ldaps?:\/\//i.test(config.ldapUrl.trim())
          ? config.ldapUrl.trim()
          : "Must start with ldap:// or ldaps://"
        : "Required (prefer ldaps://…:636)",
    },
    {
      id: "bindDn",
      label: "Bind DN",
      ok: Boolean(config.ldapBindDn.trim()),
      detail: config.ldapBindDn.trim() || "Service account DN required",
    },
    {
      id: "bindPassword",
      label: "Bind password",
      ok: Boolean(config.ldapBindPassword),
      detail: config.ldapBindPassword ? "Set" : "Required",
    },
    {
      id: "searchBase",
      label: "Search base",
      ok: Boolean(config.ldapSearchBase.trim()),
      detail: config.ldapSearchBase.trim() || "Required (e.g. DC=corp,DC=example,DC=com)",
    },
    {
      id: "searchFilter",
      label: "Search filter",
      ok: !filter || filter.includes("{{username}}"),
      detail: filter
        ? filter.includes("{{username}}")
          ? "Custom filter OK"
          : 'Must include "{{username}}"'
        : "Using default sAMAccountName / UPN filter",
    },
  ];
  return { ready: items.every((item) => item.ok), items };
}

function createClient(config: Config): Client {
  const url = config.ldapUrl.trim();
  if (!url) throw new Error("LDAP_URL is required when LDAP is enabled.");
  if (!/^ldaps?:\/\//i.test(url)) {
    throw new Error("LDAP_URL must be an ldap:// or ldaps:// URI.");
  }
  return new Client({
    url,
    timeout: 15_000,
    connectTimeout: 10_000,
    tlsOptions: {
      rejectUnauthorized: config.ldapTlsRejectUnauthorized,
    },
  });
}

function ldapErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown LDAP error.";
  const withCode = error as Error & { code?: string | number };
  const code = withCode.code != null ? String(withCode.code) : "";
  const message = error.message.replace(/\s+/g, " ").trim();
  if (code && message && !message.includes(code)) return `${message} (${code})`;
  return message || code || "Unknown LDAP error.";
}

/**
 * Live directory probe for Admin → Sign-in.
 * Always attempts service bind; optionally searches for a username (does not verify that user's password).
 */
export async function testLdapConnection(
  config: Config,
  options?: { username?: string },
): Promise<LdapTestResult> {
  const steps: LdapTestStep[] = [];
  const push = (step: LdapTestStep) => {
    steps.push(step);
  };

  try {
    assertLdapConfigured(config);
    push({
      id: "config",
      label: "Settings complete",
      ok: true,
      detail: "URL, bind DN, password, and search base are set.",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Incomplete LDAP settings.";
    push({ id: "config", label: "Settings complete", ok: false, detail });
    return {
      ok: false,
      message: detail,
      steps,
    };
  }

  const client = createClient(config);
  try {
    try {
      await client.bind(config.ldapBindDn.trim(), config.ldapBindPassword);
      push({
        id: "bind",
        label: "Service account bind",
        ok: true,
        detail: `Bound as ${config.ldapBindDn.trim()}`,
      });
    } catch (error) {
      const detail = ldapErrorDetail(error);
      push({
        id: "bind",
        label: "Service account bind",
        ok: false,
        detail,
      });
      return {
        ok: false,
        message: `Could not bind to the directory: ${detail}`,
        steps,
      };
    }

    const username = options?.username?.trim() ?? "";
    if (username) {
      try {
        const filter = buildLdapSearchFilter(config.ldapSearchFilter, username);
        const usernameAttr = config.ldapUsernameAttr.trim() || DEFAULT_LDAP_USERNAME_ATTR;
        const groupsAttr = config.ldapGroupsAttr.trim() || DEFAULT_LDAP_GROUPS_ATTR;
        const result = await client.search(config.ldapSearchBase.trim(), {
          scope: "sub",
          filter,
          sizeLimit: 2,
          attributes: [usernameAttr, groupsAttr, ...LDAP_IDENTITY_ATTRIBUTES],
          explicitBufferAttributes: LDAP_BINARY_ATTRIBUTES,
        });
        const count = result.searchEntries.length;
        if (count === 0) {
          push({
            id: "search",
            label: "User search",
            ok: false,
            detail: `No entry matched filter for “${username}”. Check search base / filter.`,
          });
          return {
            ok: false,
            message: `Bound OK, but user “${username}” was not found.`,
            steps,
          };
        }
        if (count > 1) {
          push({
            id: "search",
            label: "User search",
            ok: false,
            detail: `Filter matched ${count} entries for “${username}”; need exactly one.`,
          });
          return {
            ok: false,
            message: `Bound OK, but user search for “${username}” was ambiguous.`,
            steps,
          };
        }
        const dn = String(result.searchEntries[0]?.dn ?? "");
        push({
          id: "search",
          label: "User search",
          ok: true,
          detail: `Found ${dn || username}`,
        });
      } catch (error) {
        const detail = ldapErrorDetail(error);
        push({ id: "search", label: "User search", ok: false, detail });
        return {
          ok: false,
          message: `Bound OK, but user search failed: ${detail}`,
          steps,
        };
      }
    } else {
      push({
        id: "search",
        label: "User search",
        ok: true,
        detail: "Skipped (optional test username not provided).",
      });
    }

    const enabledNote = config.ldapEnabled
      ? "LDAP is enabled — domain password login is active for non-local usernames."
      : "Connection works. Enable LDAP and Save to accept domain password logins.";
    return {
      ok: true,
      message: enabledNote,
      steps,
    };
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}

export function createLdaptsDirectory(): LdapDirectory {
  return {
    async findUser({ username, config }) {
      const client = createClient(config);
      try {
        await client.bind(config.ldapBindDn.trim(), config.ldapBindPassword);
        const filter = buildLdapSearchFilter(config.ldapSearchFilter, username);
        const usernameAttr = config.ldapUsernameAttr.trim() || DEFAULT_LDAP_USERNAME_ATTR;
        const groupsAttr = config.ldapGroupsAttr.trim() || DEFAULT_LDAP_GROUPS_ATTR;
        const result = await client.search(config.ldapSearchBase.trim(), {
          scope: "sub",
          filter,
          sizeLimit: 2,
          attributes: [usernameAttr, groupsAttr, ...LDAP_IDENTITY_ATTRIBUTES],
          explicitBufferAttributes: LDAP_BINARY_ATTRIBUTES,
        });
        const entry = result.searchEntries[0];
        if (!entry?.dn || result.searchEntries.length !== 1) return null;
        // Copy GUID/SID bytes before unbind reuses the LDAP socket buffer.
        const { dn, ...attributes } = entry;
        return snapshotLdapEntry({ dn: String(dn), attributes });
      } finally {
        try {
          await client.unbind();
        } catch {
          /* ignore */
        }
      }
    },
    async verifyPassword({ dn, password, config }) {
      const client = createClient(config);
      try {
        await client.bind(dn, password);
        return true;
      } catch {
        return false;
      } finally {
        try {
          await client.unbind();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export function createLdapAuthProvider(
  getConfig: () => Config,
  directory: LdapDirectory = createLdaptsDirectory(),
): AuthProvider {
  return {
    async authenticate(username, password): Promise<AuthenticatedUser | null> {
      const config = getConfig();
      if (!config.ldapEnabled) return null;
      const login = username.trim();
      if (!login || !password) return null;
      if (!config.ldapUrl.trim() || !config.ldapSearchBase.trim()) return null;

      try {
        const entry = await directory.findUser({ username: login, config });
        if (!entry) return null;
        const ok = await directory.verifyPassword({
          dn: entry.dn,
          password,
          config,
        });
        if (!ok) return null;
        return entryToUser(entry, login, config);
      } catch {
        return null;
      }
    },
  };
}
