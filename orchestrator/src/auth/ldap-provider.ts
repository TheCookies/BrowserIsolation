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
