import { existsSync } from "node:fs";
import path from "node:path";
import {
  defaultAuditEnabledActions,
  parseAuditEnabledActions,
  type AuditAction,
} from "./audit-store";
import { parseAuthUsers } from "./auth/local-provider";
import {
  formatEnabledBrowsers,
  getNekoBrowser,
  imageForNekoBrowser,
  parseEnabledBrowsers,
  type BrowserType,
} from "./neko-browsers";

export type { BrowserType } from "./neko-browsers";

export const DEFAULT_SITE_NAME = "Browser Isolation";

export type Config = {
  host: string;
  port: number;
  /** Display name shown in the portal chrome and browser tab. */
  siteName: string;
  trustProxy: boolean;
  cookieSecure: boolean;
  cookieName: string;
  csrfCookieName: string;
  sessionTtlMs: number;
  databasePath: string;
  staticDir: string | null;
  authUsers: string;
  bcryptRounds: number;
  /** Enabled Neko browser ids (checkbox list in Admin). */
  enabledBrowsers: BrowserType[];
  /** Image tag for all Neko browser images (default latest). */
  nekoImageTag: string;
  browserNetwork: string;
  /**
   * How browser containers attach to the host:
   * - bridge: Docker-style custom network + published ports (compose default)
   * - host: share host netns (needed for Podman/Hyper-V where published ports are unreachable)
   */
  browserNetworkMode: "bridge" | "host";
  browserShmSizeBytes: number;
  browserNanoCpus: number;
  browserMemoryBytes: number;
  publicIp: string;
  webrtcPortStart: number;
  webrtcPortEnd: number;
  webrtcIceLite: boolean;
  iceServersFrontend: string;
  iceServersBackend: string;
  /** Neko desktop geometry, e.g. 1280x720@30 */
  desktopScreen: string;
  /** WebRTC capture codec: vp8 or h264 */
  captureVideoCodec: "vp8" | "h264";
  dockerSocketPath: string;
  /** Host/orchestrator path to browser policy overrides (no SponsorBlock). */
  nekoPoliciesDir: string;
  /** When false, users cannot enable persistent browser profiles. */
  persistProfilesEnabled: boolean;
  /**
   * Host directory for persistent browser profiles. Empty = named Podman/Docker
   * volumes. When set (Alma install: `/var/lib/browser-isolation/profiles`),
   * profiles are bind-mounted from this path so they live on the HDD.
   */
  profileDataDir: string;
  /** When false, clipboard sync to/from the isolated browser is blocked. */
  allowClipboard: boolean;
  /** When false, browser downloads and Neko file transfer are blocked. */
  allowDownloads: boolean;
  idleTimeoutMinutes: number;
  maxSessionHours: number;
  reaperIntervalSeconds: number;
  /** When true, the orchestrator host also runs browsers via local Docker. */
  localWorkerEnabled: boolean;
  /** Bootstrap remote workers: id|baseUrl|publicIp|token,... */
  workersBootstrap: string;
  /** Shared secret for worker self-enrollment (`POST /api/workers/enroll`). Empty disables enroll. */
  workerEnrollToken: string;
  /** Canonical portal origin for SAML ACS/metadata (e.g. https://rbi.example.com). */
  publicBaseUrl: string;
  samlEnabled: boolean;
  samlEntryPoint: string;
  samlIdpEntityId: string;
  /** IdP X.509 certificate (PEM or base64 DER). */
  samlIdpCert: string;
  /** Optional SP entity ID; empty means derive from PUBLIC_BASE_URL. */
  samlSpEntityId: string;
  /** Attribute name for display username; empty uses email claims then NameID. */
  samlUsernameAttr: string;
  /** Attribute name for groups; empty tries common Entra/Google claims. */
  samlGroupsAttr: string;
  /** Group/value that grants admin (case-insensitive); empty = never auto-admin. */
  samlAdminGroup: string;
  /** Which audit log actions are recorded (Settings → Audit log). */
  auditEnabledActions: AuditAction[];
};

function readBool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${name} must be true or false.`);
}

function readInt(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function resolvePath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

/** Parse Docker-style sizes such as 2g, 512m, 2gb. */
export function parseByteSize(name: string, raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|ki|kib|m|mb|mi|mib|g|gb|gi|gib)$/i);
  if (!match) {
    throw new Error(`${name} must look like 512m or 2g.`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const mult =
    unit === "b"
      ? 1
      : unit === "k" || unit === "kb" || unit === "ki" || unit === "kib"
        ? 1024
        : unit === "m" || unit === "mb" || unit === "mi" || unit === "mib"
          ? 1024 ** 2
          : 1024 ** 3;
  const bytes = Math.round(amount * mult);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`${name} must be a positive size.`);
  }
  return bytes;
}

export function parsePortRange(name: string, raw: string): { start: number; end: number } {
  const match = raw.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    throw new Error(`${name} must look like 52000-52099.`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    throw new Error(`${name} must be a valid inclusive port range.`);
  }
  return { start, end };
}

function parseCpu(raw: string | undefined): number {
  const value = Number(raw?.trim() || "3");
  if (!Number.isFinite(value) || value <= 0 || value > 64) {
    throw new Error("BROWSER_CPUS must be a number from 0 exclusive to 64.");
  }
  return Math.round(value * 1e9);
}

/** Portal display name; blank/missing falls back to the product default. */
export function normalizeSiteName(raw: string | undefined | null): string {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!value) return DEFAULT_SITE_NAME;
  if (value.length > 64) {
    throw new Error("SITE_NAME must be at most 64 characters.");
  }
  return value;
}

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

export function loadConfig(env: NodeJS.ProcessEnv, baseDir: string): Config {
  // Bootstrap seed for local_users when the DB is empty. After the first run,
  // manage accounts in Admin → Users; AUTH_USERS is ignored if users already exist.
  const authUsers = env.AUTH_USERS?.trim() ?? "";
  if (authUsers) {
    parseAuthUsers(authUsers);
  }

  const nodeEnv = env.NODE_ENV ?? "development";
  const staticFromEnv = env.STATIC_DIR?.trim();
  const defaultStatic = path.join(baseDir, "web", "dist");
  const serveStatic = Boolean(staticFromEnv) || nodeEnv === "production" || env.SERVE_STATIC === "true";
  let staticDir: string | null = null;
  if (serveStatic) {
    staticDir = staticFromEnv ? resolvePath(baseDir, staticFromEnv) : defaultStatic;
    if (!existsSync(staticDir)) {
      throw new Error(`Static files not found at ${staticDir}. Build the web app first.`);
    }
  }

  const databasePath = env.DATABASE_PATH?.trim()
    ? resolvePath(baseDir, env.DATABASE_PATH.trim())
    : path.join(baseDir, "data", "rbi.sqlite");

  const sessionTtlHours = readInt("SESSION_TTL_HOURS", env.SESSION_TTL_HOURS, 24, 1, 24 * 30);
  const portRange = parsePortRange("WEBRTC_PORT_RANGE", env.WEBRTC_PORT_RANGE?.trim() || "52000-52099");
  const iceFrontend = assertJsonArray("ICE_SERVERS_FRONTEND", env.ICE_SERVERS_FRONTEND?.trim() || "[]");
  const iceBackend = assertJsonArray("ICE_SERVERS_BACKEND", env.ICE_SERVERS_BACKEND?.trim() || "[]");
  const publicIp = env.PUBLIC_IP?.trim() || "127.0.0.1";
  if (!publicIp) {
    throw new Error("PUBLIC_IP is required.");
  }

  const desktopScreen = env.DESKTOP_SCREEN?.trim() || "1280x720@30";
  if (!/^\d{3,5}x\d{3,5}@\d{1,3}$/.test(desktopScreen)) {
    throw new Error("DESKTOP_SCREEN must look like 1280x720@30.");
  }

  const codecRaw = (env.CAPTURE_VIDEO_CODEC?.trim() || "h264").toLowerCase();
  if (codecRaw !== "vp8" && codecRaw !== "h264") {
    throw new Error('CAPTURE_VIDEO_CODEC must be "vp8" or "h264".');
  }

  const enabledBrowsers = parseEnabledBrowsers(env.ENABLED_BROWSERS);
  const nekoImageTag = env.NEKO_IMAGE_TAG?.trim() || "latest";

  const siteName = normalizeSiteName(env.SITE_NAME);

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: readInt("PORT", env.PORT, 8080, 1, 65535),
    siteName,
    trustProxy: readBool("TRUST_PROXY", env.TRUST_PROXY, false),
    cookieSecure: readBool("COOKIE_SECURE", env.COOKIE_SECURE, false),
    cookieName: "rbi_session",
    csrfCookieName: "rbi_csrf",
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    databasePath,
    staticDir,
    authUsers,
    bcryptRounds: readInt("BCRYPT_ROUNDS", env.BCRYPT_ROUNDS, 12, 4, 15),
    enabledBrowsers,
    nekoImageTag,
    browserNetwork: env.BROWSER_NETWORK?.trim() || "rbi-browsers",
    browserNetworkMode: (() => {
      const mode = (env.BROWSER_NETWORK_MODE?.trim() || "bridge").toLowerCase();
      if (mode !== "bridge" && mode !== "host") {
        throw new Error('BROWSER_NETWORK_MODE must be "bridge" or "host".');
      }
      return mode;
    })(),
    browserShmSizeBytes: parseByteSize("BROWSER_SHM_SIZE", env.BROWSER_SHM_SIZE?.trim() || "2gb"),
    browserNanoCpus: parseCpu(env.BROWSER_CPUS),
    browserMemoryBytes: parseByteSize("BROWSER_MEMORY", env.BROWSER_MEMORY?.trim() || "2g"),
    publicIp,
    webrtcPortStart: portRange.start,
    webrtcPortEnd: portRange.end,
    webrtcIceLite: readBool("WEBRTC_ICELITE", env.WEBRTC_ICELITE, true),
    iceServersFrontend: iceFrontend,
    iceServersBackend: iceBackend,
    desktopScreen,
    captureVideoCodec: codecRaw,
    dockerSocketPath: env.DOCKER_SOCKET?.trim() || "/var/run/docker.sock",
    nekoPoliciesDir:
      env.NEKO_POLICIES_DIR?.trim() ||
      path.resolve(__dirname, "..", "neko-policies"),
    persistProfilesEnabled: readBool(
      "PERSIST_PROFILES_ENABLED",
      env.PERSIST_PROFILES_ENABLED,
      true,
    ),
    profileDataDir: env.PROFILE_DATA_DIR?.trim()
      ? resolvePath(baseDir, env.PROFILE_DATA_DIR.trim())
      : "",
    allowClipboard: readBool("ALLOW_CLIPBOARD", env.ALLOW_CLIPBOARD, false),
    allowDownloads: readBool("ALLOW_DOWNLOADS", env.ALLOW_DOWNLOADS, false),
    idleTimeoutMinutes: readInt("IDLE_TIMEOUT_MINUTES", env.IDLE_TIMEOUT_MINUTES, 60, 1, 24 * 60),
    maxSessionHours: readInt("MAX_SESSION_HOURS", env.MAX_SESSION_HOURS, 12, 1, 24 * 14),
    reaperIntervalSeconds: readInt("REAPER_INTERVAL_SECONDS", env.REAPER_INTERVAL_SECONDS, 60, 5, 3600),
    localWorkerEnabled: readBool("LOCAL_WORKER_ENABLED", env.LOCAL_WORKER_ENABLED, true),
    workersBootstrap: env.WORKERS?.trim() ?? "",
    workerEnrollToken: env.WORKER_ENROLL_TOKEN?.trim() ?? "",
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim() ?? "",
    samlEnabled: readBool("SAML_ENABLED", env.SAML_ENABLED, false),
    samlEntryPoint: env.SAML_ENTRY_POINT?.trim() ?? "",
    samlIdpEntityId: env.SAML_IDP_ENTITY_ID?.trim() ?? "",
    samlIdpCert: env.SAML_IDP_CERT?.trim() ?? "",
    samlSpEntityId: env.SAML_SP_ENTITY_ID?.trim() ?? "",
    samlUsernameAttr: env.SAML_USERNAME_ATTR?.trim() ?? "",
    samlGroupsAttr: env.SAML_GROUPS_ATTR?.trim() ?? "",
    samlAdminGroup: env.SAML_ADMIN_GROUP?.trim() ?? "",
    auditEnabledActions: env.AUDIT_ENABLED_ACTIONS?.trim()
      ? parseAuditEnabledActions(env.AUDIT_ENABLED_ACTIONS)
      : defaultAuditEnabledActions(),
  };
}

export function imageForBrowser(config: Config, browser: BrowserType): string {
  const meta = getNekoBrowser(browser);
  if (!meta) throw new Error(`Unknown browser ${browser}`);
  return imageForNekoBrowser(meta, config.nekoImageTag);
}

export function imagesForBrowsers(
  config: Config,
  browsers: readonly BrowserType[] = config.enabledBrowsers,
): string[] {
  return [...new Set(browsers.map((browser) => imageForBrowser(config, browser)))];
}

/** In-container path for the managed policy file (Neko browser images). */
export function policyMountForBrowser(browser: BrowserType): {
  dir: string;
  fileName: string;
  policySource: NonNullable<ReturnType<typeof getNekoBrowser>>["policySource"];
} | null {
  const meta = getNekoBrowser(browser);
  if (!meta || !meta.policyDir || !meta.policySource) return null;
  return {
    dir: meta.policyDir,
    fileName: meta.policyFileName,
    policySource: meta.policySource,
  };
}

export function enabledBrowsersCsv(config: Config): string {
  return formatEnabledBrowsers(config.enabledBrowsers);
}
