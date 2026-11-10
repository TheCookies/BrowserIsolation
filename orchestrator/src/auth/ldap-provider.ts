import { Client, Filter } from "ldapts";
import type { Config } from "../config";
import { ldapSubjectId } from "./identity";
import type { AuthProvider, AuthenticatedUser, Role } from "./provider";

export const DEFAULT_LDAP_SEARCH_FILTER =
  "(|(sAMAccountName={{username}})(userPrincipalName={{username}}))";
export const DEFAULT_LDAP_USERNAME_ATTR = "sAMAccountName";
export const DEFAULT_LDAP_GROUPS_ATTR = "memberOf";

export type LdapUserEntry = {
  dn: string;
  attributes: Record<string, Buffer | Buffer[] | string | string[]>;
};

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

function asStringList(value: Buffer | Buffer[] | string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => asStringList(item));
  }
  if (Buffer.isBuffer(value)) {
    return [value.toString("utf8")];
  }
  const text = String(value).trim();
  return text ? [text] : [];
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
  if (!key) return fallback;
  return asStringList(entry.attributes[key])[0] ?? fallback;
}

export function resolveLdapGroups(entry: LdapUserEntry, groupsAttr: string): string[] {
  const attr = (groupsAttr.trim() || DEFAULT_LDAP_GROUPS_ATTR).toLowerCase();
  const key = Object.keys(entry.attributes).find((name) => name.toLowerCase() === attr);
  if (!key) return [];
  return asStringList(entry.attributes[key]);
}

export function resolveLdapSubjectId(entry: LdapUserEntry): string {
  const guidKey = Object.keys(entry.attributes).find(
    (name) => name.toLowerCase() === "objectguid",
  );
  if (guidKey) {
    const raw = entry.attributes[guidKey];
    const buf = Array.isArray(raw) ? raw[0] : raw;
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      return ldapSubjectId(formatObjectGuid(buf));
    }
    if (typeof buf === "string" && buf.trim()) {
      return ldapSubjectId(buf.trim());
    }
  }
  return ldapSubjectId(entry.dn);
}

export function entryToUser(
  entry: LdapUserEntry,
  loginUsername: string,
  config: Pick<Config, "ldapUsernameAttr" | "ldapGroupsAttr" | "ldapAdminGroup">,
): AuthenticatedUser {
  const username = resolveLdapDisplayUsername(entry, config.ldapUsernameAttr, loginUsername);
  const groups = resolveLdapGroups(entry, config.ldapGroupsAttr);
  return {
    username,
    role: mapLdapRole(groups, config.ldapAdminGroup),
    subjectId: resolveLdapSubjectId(entry),
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
          attributes: [usernameAttr, groupsAttr, "dn", "distinguishedName"],
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
          attributes: [usernameAttr, groupsAttr, "objectGUID", "dn", "distinguishedName"],
          explicitBufferAttributes: ["objectGUID"],
        });
        const entry = result.searchEntries[0];
        if (!entry?.dn || result.searchEntries.length !== 1) return null;
        const { dn, ...attributes } = entry;
        return { dn: String(dn), attributes };
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
