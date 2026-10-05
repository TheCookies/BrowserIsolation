/**
 * Admin-editable settings. Values are stored as strings in SQLite and applied
 * onto the live Config object. .env remains the bootstrap default; DB overrides
 * win after startup.
 */

export type SettingGroup =
  | "portal"
  | "security"
  | "browser"
  | "webrtc"
  | "cleanup"
  | "sso"
  | "audit";

export type SettingFieldType =
  | "string"
  | "boolean"
  | "number"
  | "select"
  | "json"
  | "size"
  | "text";

export type SettingField = {
  key: string;
  label: string;
  description: string;
  group: SettingGroup;
  type: SettingFieldType;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** When true, changing the value only affects new work (documented in UI). */
  appliesToNewSessions?: boolean;
};

export const SETTING_GROUPS: Array<{ id: SettingGroup; title: string; hint: string }> = [
  {
    id: "portal",
    title: "Portal",
    hint: "Branding, cookies, and session behavior for the control plane.",
  },
  {
    id: "security",
    title: "Security",
    hint: "Data transfer controls between the user and isolated browsers.",
  },
  {
    id: "browser",
    title: "Browser resources",
    hint: "Limits applied when launching a new isolated browser.",
  },
  {
    id: "webrtc",
    title: "WebRTC / media",
    hint: "Streaming and ICE settings for remote desktops.",
  },
  {
    id: "cleanup",
    title: "Cleanup",
    hint: "Idle and lifetime limits for browser sessions.",
  },
  {
    id: "sso",
    title: "SSO / SAML",
    hint: "Connect Google Workspace, Microsoft Entra ID, or any SAML 2.0 identity provider.",
  },
  {
    id: "audit",
    title: "Audit log",
    hint: "Choose which administrator and user actions are recorded.",
  },
];

export const EDITABLE_SETTINGS: SettingField[] = [
  {
    key: "SITE_NAME",
    label: "Site name",
    description: "Name shown in the portal header, login page, and browser tab.",
    group: "portal",
    type: "string",
  },
  {
    key: "TRUST_PROXY",
    label: "Trust proxy headers",
    description: "Honor X-Forwarded-* when behind a reverse proxy.",
    group: "portal",
    type: "boolean",
  },
  {
    key: "COOKIE_SECURE",
    label: "Secure cookies",
    description: "Set the Secure flag on portal cookies (use with HTTPS).",
    group: "portal",
    type: "boolean",
  },
  {
    key: "SESSION_TTL_HOURS",
    label: "Portal session TTL (hours)",
    description: "How long portal logins last. Applies to new logins.",
    group: "portal",
    type: "number",
    min: 1,
    max: 24 * 30,
  },
  {
    key: "PERSIST_PROFILES_ENABLED",
    label: "Allow persistent profiles",
    description: "Let users opt into per-account browser profile volumes.",
    group: "portal",
    type: "boolean",
  },
  {
    key: "ALLOW_CLIPBOARD",
    label: "Allow copy / paste",
    description:
      "Sync clipboard text to and from the isolated browser. Disabled by default to prevent data exfiltration.",
    group: "security",
    type: "boolean",
    appliesToNewSessions: true,
  },
  {
    key: "ALLOW_DOWNLOADS",
    label: "Allow downloads",
    description:
      "Allow transferring files between the user and the isolated browser (downloads and uploads). Disabled by default.",
    group: "security",
    type: "boolean",
    appliesToNewSessions: true,
  },
  {
    key: "PUBLIC_IP",
    label: "Public IP",
    description: "Address advertised in WebRTC candidates.",
    group: "webrtc",
    type: "string",
    appliesToNewSessions: true,
  },
  {
    key: "WEBRTC_ICELITE",
    label: "ICE lite",
    description: "Use ICE lite (typical without TURN). Disable when using TURN.",
    group: "webrtc",
    type: "boolean",
    appliesToNewSessions: true,
  },
  {
    key: "ICE_SERVERS_FRONTEND",
    label: "ICE servers (frontend)",
    description: "JSON array of RTCIceServer objects for the browser client.",
    group: "webrtc",
    type: "json",
    appliesToNewSessions: true,
  },
  {
    key: "ICE_SERVERS_BACKEND",
    label: "ICE servers (backend)",
    description: "JSON array of RTCIceServer objects for Neko.",
    group: "webrtc",
    type: "json",
    appliesToNewSessions: true,
  },
  {
    key: "DESKTOP_SCREEN",
    label: "Desktop screen",
    description: "Cold-start capture size@fps, e.g. 1280x720@30.",
    group: "webrtc",
    type: "string",
    appliesToNewSessions: true,
  },
  {
    key: "CAPTURE_VIDEO_CODEC",
    label: "Capture codec",
    description: "WebRTC video codec used by Neko.",
    group: "webrtc",
    type: "select",
    options: ["vp8", "h264"],
    appliesToNewSessions: true,
  },
  {
    key: "BROWSER_CPUS",
    label: "Browser CPUs",
    description: "CPU limit per browser container (e.g. 3).",
    group: "browser",
    type: "number",
    min: 0.25,
    max: 64,
    appliesToNewSessions: true,
  },
  {
    key: "BROWSER_MEMORY",
    label: "Browser memory",
    description: "Memory limit per browser container (e.g. 2g).",
    group: "browser",
    type: "size",
    appliesToNewSessions: true,
  },
  {
    key: "BROWSER_SHM_SIZE",
    label: "Browser /dev/shm",
    description: "Shared memory size for browser containers (e.g. 2gb).",
    group: "browser",
    type: "size",
    appliesToNewSessions: true,
  },
  {
    key: "IDLE_TIMEOUT_MINUTES",
    label: "Idle timeout (minutes)",
    description: "Destroy sessions with no viewers after this many minutes.",
    group: "cleanup",
    type: "number",
    min: 1,
    max: 24 * 60,
  },
  {
    key: "MAX_SESSION_HOURS",
    label: "Max session lifetime (hours)",
    description: "Hard cap on browser session age.",
    group: "cleanup",
    type: "number",
    min: 1,
    max: 24 * 14,
  },
  {
    key: "REAPER_INTERVAL_SECONDS",
    label: "Reaper interval (seconds)",
    description: "How often the cleanup scanner runs.",
    group: "cleanup",
    type: "number",
    min: 5,
    max: 3600,
  },
  {
    key: "SAML_ENABLED",
    label: "Enable SAML SSO",
    description:
      "Show Sign in with SSO on the login page. Local password login remains available as break-glass.",
    group: "sso",
    type: "boolean",
  },
  {
    key: "PUBLIC_BASE_URL",
    label: "Public base URL",
    description:
      "Canonical portal origin used in SAML ACS and metadata (e.g. https://rbi.example.com). Required when SSO is enabled.",
    group: "sso",
    type: "string",
  },
  {
    key: "SAML_ENTRY_POINT",
    label: "IdP SSO URL",
    description: "Identity provider single sign-on URL (SAML HTTP-Redirect or POST binding).",
    group: "sso",
    type: "string",
  },
  {
    key: "SAML_IDP_ENTITY_ID",
    label: "IdP entity ID",
    description: "Optional issuer/entity ID from the IdP metadata.",
    group: "sso",
    type: "string",
  },
  {
    key: "SAML_IDP_CERT",
    label: "IdP certificate",
    description:
      "X.509 signing certificate from the IdP (PEM with BEGIN CERTIFICATE, or bare base64).",
    group: "sso",
    type: "text",
  },
  {
    key: "SAML_SP_ENTITY_ID",
    label: "SP entity ID (optional)",
    description: "Leave blank to use the default metadata URL from the public base URL.",
    group: "sso",
    type: "string",
  },
  {
    key: "SAML_USERNAME_ATTR",
    label: "Username attribute (optional)",
    description:
      "Assertion attribute for the display username. Blank tries common email claims, then NameID.",
    group: "sso",
    type: "string",
  },
  {
    key: "SAML_GROUPS_ATTR",
    label: "Groups attribute (optional)",
    description:
      "Assertion attribute listing groups. Blank tries Entra/Google defaults (groups, role claims).",
    group: "sso",
    type: "string",
  },
  {
    key: "SAML_ADMIN_GROUP",
    label: "Admin group value",
    description:
      "If any group equals this value (case-insensitive), the user is an administrator. Leave blank to never auto-promote.",
    group: "sso",
    type: "string",
  },
  {
    key: "AUDIT_ENABLED_ACTIONS",
    label: "Logged actions",
    description: "JSON array of audit action ids that are recorded.",
    group: "audit",
    type: "json",
  },
];

export type ReadonlySetting = {
  key: string;
  label: string;
  description: string;
  value: string;
};

export function editableKeys(): Set<string> {
  return new Set(EDITABLE_SETTINGS.map((field) => field.key));
}
