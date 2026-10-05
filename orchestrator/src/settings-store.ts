import type Database from "better-sqlite3";
import {
  formatAuditEnabledActions,
  parseAuditEnabledActions,
} from "./audit-store";
import type { Config } from "./config";
import { normalizeSiteName, parseByteSize } from "./config";
import {
  formatEnabledBrowsers,
  parseEnabledBrowsers,
} from "./neko-browsers";
import { assertSamlReady, normalizeIdpCert, normalizePublicBaseUrl } from "./auth/saml";
import {
  EDITABLE_SETTINGS,
  editableKeys,
  type ReadonlySetting,
  type SettingField,
} from "./settings-fields";

export type SettingsSnapshot = {
  editable: Array<SettingField & { value: string; overridden: boolean }>;
  readonly: ReadonlySetting[];
};

export type SettingsStore = {
  list(): SettingsSnapshot;
  update(patch: Record<string, string>): { updated: string[] };
  /** Persist enabled browser checkboxes (Admin → Browsers). */
  setEnabledBrowsers(ids: string[]): { enabled: string[] };
  /** Apply all stored overrides onto the live config object. */
  hydrateConfig(): void;
};

/** Keys persisted in app_settings that are not shown in the Settings form. */
const HIDDEN_SETTINGS = new Set(["ENABLED_BROWSERS", "NEKO_IMAGE_TAG"]);

function assertJsonArray(name: string, raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return JSON.stringify(parsed);
}

function readBool(name: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${name} must be true or false.`);
}

function readNumber(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

/** Current effective string value for an editable env key. */
export function configValueForKey(config: Config, key: string): string {
  switch (key) {
    case "SITE_NAME":
      return config.siteName;
    case "TRUST_PROXY":
      return config.trustProxy ? "true" : "false";
    case "COOKIE_SECURE":
      return config.cookieSecure ? "true" : "false";
    case "SESSION_TTL_HOURS":
      return String(Math.round(config.sessionTtlMs / (60 * 60 * 1000)));
    case "PERSIST_PROFILES_ENABLED":
      return config.persistProfilesEnabled ? "true" : "false";
    case "ALLOW_CLIPBOARD":
      return config.allowClipboard ? "true" : "false";
    case "ALLOW_DOWNLOADS":
      return config.allowDownloads ? "true" : "false";
    case "PUBLIC_IP":
      return config.publicIp;
    case "WEBRTC_ICELITE":
      return config.webrtcIceLite ? "true" : "false";
    case "ICE_SERVERS_FRONTEND":
      return config.iceServersFrontend;
    case "ICE_SERVERS_BACKEND":
      return config.iceServersBackend;
    case "DESKTOP_SCREEN":
      return config.desktopScreen;
    case "CAPTURE_VIDEO_CODEC":
      return config.captureVideoCodec;
    case "BROWSER_CPUS":
      return String(config.browserNanoCpus / 1e9);
    case "BROWSER_MEMORY": {
      const gib = config.browserMemoryBytes / 1024 ** 3;
      if (Number.isInteger(gib) && gib >= 1) return `${gib}g`;
      const mib = config.browserMemoryBytes / 1024 ** 2;
      if (Number.isInteger(mib)) return `${mib}m`;
      return `${config.browserMemoryBytes}b`;
    }
    case "BROWSER_SHM_SIZE": {
      const gib = config.browserShmSizeBytes / 1024 ** 3;
      if (Number.isInteger(gib) && gib >= 1) return `${gib}gb`;
      const mib = config.browserShmSizeBytes / 1024 ** 2;
      if (Number.isInteger(mib)) return `${mib}mb`;
      return `${config.browserShmSizeBytes}b`;
    }
    case "ENABLED_BROWSERS":
      return formatEnabledBrowsers(config.enabledBrowsers);
    case "NEKO_IMAGE_TAG":
      return config.nekoImageTag;
    case "IDLE_TIMEOUT_MINUTES":
      return String(config.idleTimeoutMinutes);
    case "MAX_SESSION_HOURS":
      return String(config.maxSessionHours);
    case "REAPER_INTERVAL_SECONDS":
      return String(config.reaperIntervalSeconds);
    case "SAML_ENABLED":
      return config.samlEnabled ? "true" : "false";
    case "PUBLIC_BASE_URL":
      return config.publicBaseUrl;
    case "SAML_ENTRY_POINT":
      return config.samlEntryPoint;
    case "SAML_IDP_ENTITY_ID":
      return config.samlIdpEntityId;
    case "SAML_IDP_CERT":
      return config.samlIdpCert;
    case "SAML_SP_ENTITY_ID":
      return config.samlSpEntityId;
    case "SAML_USERNAME_ATTR":
      return config.samlUsernameAttr;
    case "SAML_GROUPS_ATTR":
      return config.samlGroupsAttr;
    case "SAML_ADMIN_GROUP":
      return config.samlAdminGroup;
    case "AUDIT_ENABLED_ACTIONS":
      return formatAuditEnabledActions(config.auditEnabledActions);
    default:
      throw new Error(`Unknown setting ${key}`);
  }
}

export function applySettingToConfig(config: Config, key: string, raw: string): void {
  const value = raw.trim();
  switch (key) {
    case "SITE_NAME":
      config.siteName = normalizeSiteName(value);
      return;
    case "TRUST_PROXY":
      config.trustProxy = readBool(key, value);
      return;
    case "COOKIE_SECURE":
      config.cookieSecure = readBool(key, value);
      return;
    case "SESSION_TTL_HOURS": {
      const hours = readNumber(key, value, 1, 24 * 30);
      if (!Number.isInteger(hours)) throw new Error(`${key} must be an integer.`);
      config.sessionTtlMs = hours * 60 * 60 * 1000;
      return;
    }
    case "PERSIST_PROFILES_ENABLED":
      config.persistProfilesEnabled = readBool(key, value);
      return;
    case "ALLOW_CLIPBOARD":
      config.allowClipboard = readBool(key, value);
      return;
    case "ALLOW_DOWNLOADS":
      config.allowDownloads = readBool(key, value);
      return;
    case "PUBLIC_IP":
      if (!value) throw new Error("PUBLIC_IP is required.");
      config.publicIp = value;
      return;
    case "WEBRTC_ICELITE":
      config.webrtcIceLite = readBool(key, value);
      return;
    case "ICE_SERVERS_FRONTEND":
      config.iceServersFrontend = assertJsonArray(key, value || "[]");
      return;
    case "ICE_SERVERS_BACKEND":
      config.iceServersBackend = assertJsonArray(key, value || "[]");
      return;
    case "DESKTOP_SCREEN":
      if (!/^\d{3,5}x\d{3,5}@\d{1,3}$/.test(value)) {
        throw new Error("DESKTOP_SCREEN must look like 1280x720@30.");
      }
      config.desktopScreen = value;
      return;
    case "CAPTURE_VIDEO_CODEC": {
      const codec = value.toLowerCase();
      if (codec !== "vp8" && codec !== "h264") {
        throw new Error('CAPTURE_VIDEO_CODEC must be "vp8" or "h264".');
      }
      config.captureVideoCodec = codec;
      return;
    }
    case "BROWSER_CPUS": {
      const cpus = readNumber(key, value, 0.25, 64);
      config.browserNanoCpus = Math.round(cpus * 1e9);
      return;
    }
    case "BROWSER_MEMORY":
      config.browserMemoryBytes = parseByteSize(key, value);
      return;
    case "BROWSER_SHM_SIZE":
      config.browserShmSizeBytes = parseByteSize(key, value);
      return;
    case "ENABLED_BROWSERS":
      config.enabledBrowsers = parseEnabledBrowsers(value);
      return;
    case "NEKO_IMAGE_TAG":
      if (!value) throw new Error("NEKO_IMAGE_TAG is required.");
      if (!/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error("NEKO_IMAGE_TAG must be a simple Docker tag.");
      }
      config.nekoImageTag = value;
      return;
    case "IDLE_TIMEOUT_MINUTES": {
      const minutes = readNumber(key, value, 1, 24 * 60);
      if (!Number.isInteger(minutes)) throw new Error(`${key} must be an integer.`);
      config.idleTimeoutMinutes = minutes;
      return;
    }
    case "MAX_SESSION_HOURS": {
      const hours = readNumber(key, value, 1, 24 * 14);
      if (!Number.isInteger(hours)) throw new Error(`${key} must be an integer.`);
      config.maxSessionHours = hours;
      return;
    }
    case "REAPER_INTERVAL_SECONDS": {
      const seconds = readNumber(key, value, 5, 3600);
      if (!Number.isInteger(seconds)) throw new Error(`${key} must be an integer.`);
      config.reaperIntervalSeconds = seconds;
      return;
    }
    case "SAML_ENABLED":
      config.samlEnabled = readBool(key, value);
      return;
    case "PUBLIC_BASE_URL":
      config.publicBaseUrl = value ? normalizePublicBaseUrl(value) : "";
      return;
    case "SAML_ENTRY_POINT":
      if (value && !/^https?:\/\//i.test(value)) {
        throw new Error("SAML_ENTRY_POINT must be an absolute http(s) URL.");
      }
      config.samlEntryPoint = value;
      return;
    case "SAML_IDP_ENTITY_ID":
      config.samlIdpEntityId = value;
      return;
    case "SAML_IDP_CERT":
      config.samlIdpCert = value ? normalizeIdpCert(value) : "";
      return;
    case "SAML_SP_ENTITY_ID":
      config.samlSpEntityId = value;
      return;
    case "SAML_USERNAME_ATTR":
      config.samlUsernameAttr = value;
      return;
    case "SAML_GROUPS_ATTR":
      config.samlGroupsAttr = value;
      return;
    case "SAML_ADMIN_GROUP":
      config.samlAdminGroup = value;
      return;
    case "AUDIT_ENABLED_ACTIONS":
      config.auditEnabledActions = parseAuditEnabledActions(value || "[]");
      return;
    default:
      throw new Error(`Setting ${key} is not editable.`);
  }
}

function readonlySettings(config: Config): ReadonlySetting[] {
  return [
    {
      key: "PORT",
      label: "Listen port",
      description: "HTTP port the portal listens on.",
      value: String(config.port),
    },
    {
      key: "DATABASE_PATH",
      label: "Database path",
      description: "SQLite file used for portal state.",
      value: config.databasePath,
    },
    {
      key: "DOCKER_SOCKET",
      label: "Docker socket",
      description: "Docker Engine socket path.",
      value: config.dockerSocketPath,
    },
    {
      key: "BROWSER_NETWORK",
      label: "Browser network",
      description: "Docker/Podman network for browser containers (bridge mode).",
      value: config.browserNetwork,
    },
    {
      key: "BROWSER_NETWORK_MODE",
      label: "Browser network mode",
      description: 'bridge (compose) or host (Podman/Hyper-V when published ports are unreachable).',
      value: config.browserNetworkMode,
    },
    {
      key: "WEBRTC_PORT_RANGE",
      label: "WebRTC port range",
      description: "Host UDP/TCP mux range (requires restart to change).",
      value: `${config.webrtcPortStart}-${config.webrtcPortEnd}`,
    },
    {
      key: "NEKO_IMAGE_TAG",
      label: "Neko image tag",
      description: "Tag used for all browser images (Pull latest uses this; default latest).",
      value: config.nekoImageTag,
    },
    {
      key: "ENABLED_BROWSERS",
      label: "Enabled browsers",
      description: "Managed in Admin → Browsers (checkboxes).",
      value: formatEnabledBrowsers(config.enabledBrowsers),
    },
    {
      key: "AUTH_USERS",
      label: "Local accounts seed",
      description: "Initial accounts used only when the database is empty. Manage users under Users.",
      value: config.authUsers.trim()
        ? `${config.authUsers.split(",").filter(Boolean).length} seed account(s)`
        : "none",
    },
  ];
}

export function createSettingsStore(db: Database.Database, config: Config): SettingsStore {
  const keys = editableKeys();
  const hydratedKeys = new Set([...keys, ...HIDDEN_SETTINGS]);
  const selectAll = db.prepare<[], { key: string; value: string }>(
    `SELECT key, value FROM app_settings`,
  );
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  function overrides(): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of selectAll.all()) {
      if (hydratedKeys.has(row.key)) map.set(row.key, row.value);
    }
    return map;
  }

  return {
    hydrateConfig() {
      for (const [key, value] of overrides()) {
        try {
          applySettingToConfig(config, key, value);
        } catch {
          // Ignore stale/invalid rows (e.g. removed image settings).
        }
      }
    },

    list() {
      const stored = overrides();
      return {
        editable: EDITABLE_SETTINGS.map((field) => ({
          ...field,
          value: configValueForKey(config, field.key),
          overridden: stored.has(field.key),
        })),
        readonly: readonlySettings(config),
      };
    },

    setEnabledBrowsers(ids) {
      const csv = formatEnabledBrowsers(parseEnabledBrowsers(ids.join(",")));
      applySettingToConfig(config, "ENABLED_BROWSERS", csv);
      upsert.run("ENABLED_BROWSERS", csv, Date.now());
      return { enabled: [...config.enabledBrowsers] };
    },

    update(patch) {
      const entries = Object.entries(patch);
      if (entries.length === 0) {
        throw Object.assign(new Error("empty_patch"), { statusCode: 400 });
      }

      const trial: Config = { ...config };
      for (const [key, raw] of entries) {
        if (!keys.has(key)) {
          throw Object.assign(new Error(`unknown_setting:${key}`), { statusCode: 400 });
        }
        try {
          applySettingToConfig(trial, key, String(raw));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), { statusCode: 400 });
        }
      }
      try {
        assertSamlReady(trial);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(message), { statusCode: 400 });
      }

      const updated: string[] = [];
      const now = Date.now();
      const tx = db.transaction(() => {
        for (const [key, raw] of entries) {
          // Preserve PEM newlines for the IdP certificate.
          const next =
            key === "SAML_IDP_CERT" ? String(raw).replace(/\r\n/g, "\n").trim() : String(raw).trim();
          applySettingToConfig(config, key, next);
          upsert.run(key, next, now);
          updated.push(key);
        }
      });
      tx();
      return { updated };
    },
  };
}
