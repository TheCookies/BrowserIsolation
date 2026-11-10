import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  deleteAdminLogo,
  getAdminAudit,
  getAdminBranding,
  getAdminSettings,
  testAdminLdapSettings,
  updateAdminSettings,
  uploadAdminLogo,
  type AdminAuditActionDef,
  type AdminReadonlySetting,
  type AdminSettingField,
  type BrandingLogo,
  type LdapTestResult,
} from "../../api";
import { useAdminContext } from "./context";

type ModalId =
  | "branding"
  | "sso"
  | "security"
  | "sessions"
  | "browser"
  | "streaming"
  | "audit"
  | "advanced";

const SECTION_KEYS: Record<Exclude<ModalId, "sso" | "audit">, readonly string[]> = {
  branding: ["SITE_NAME"],
  security: ["ALLOW_CLIPBOARD", "ALLOW_DOWNLOADS"],
  sessions: [
    "SESSION_TTL_HOURS",
    "PERSIST_PROFILES_ENABLED",
    "IDLE_TIMEOUT_MINUTES",
    "MAX_SESSION_HOURS",
    "REAPER_INTERVAL_SECONDS",
  ],
  browser: ["BROWSER_CPUS", "BROWSER_MEMORY", "BROWSER_SHM_SIZE"],
  streaming: [
    "PUBLIC_IP",
    "WEBRTC_ICELITE",
    "ICE_SERVERS_FRONTEND",
    "ICE_SERVERS_BACKEND",
    "DESKTOP_SCREEN",
    "CAPTURE_VIDEO_CODEC",
  ],
  advanced: ["TRUST_PROXY", "COOKIE_SECURE"],
};

const SAML_KEYS = [
  "SAML_ENABLED",
  "PUBLIC_BASE_URL",
  "SAML_ENTRY_POINT",
  "SAML_IDP_ENTITY_ID",
  "SAML_IDP_CERT",
  "SAML_SP_ENTITY_ID",
  "SAML_USERNAME_ATTR",
  "SAML_GROUPS_ATTR",
  "SAML_ADMIN_GROUP",
] as const;

const LDAP_KEYS = [
  "LDAP_ENABLED",
  "LDAP_URL",
  "LDAP_BIND_DN",
  "LDAP_BIND_PASSWORD",
  "LDAP_SEARCH_BASE",
  "LDAP_SEARCH_FILTER",
  "LDAP_USERNAME_ATTR",
  "LDAP_GROUPS_ATTR",
  "LDAP_ADMIN_GROUP",
  "LDAP_TLS_REJECT_UNAUTHORIZED",
] as const;

const SSO_KEYS = [...SAML_KEYS, ...LDAP_KEYS] as const;

const SSO_HELP: Record<string, string> = {
  SAML_ENABLED:
    "Shows Sign in with SSO on the login page. Local username/password stays available as break-glass.",
  PUBLIC_BASE_URL:
    "Exact public origin users open (include https://). Example: https://rbi.example.com — builds ACS and metadata URLs.",
  SAML_ENTRY_POINT:
    "From your IdP: “Login URL”, “SSO URL”, or singleSignOnService Location in metadata.",
  SAML_IDP_ENTITY_ID:
    "Optional. From IdP metadata EntityDescriptor entityID (Entra Identifier / Google Entity ID).",
  SAML_IDP_CERT:
    "IdP X.509 signing certificate (PEM or Base64). Entra: download Certificate (Base64). Google: download Certificate.",
  SAML_SP_ENTITY_ID:
    "Optional override for this app’s audience/entity ID. Leave blank to use the Metadata URL below.",
  SAML_USERNAME_ATTR:
    "Optional assertion attribute for display name. Blank uses common email claims, then NameID.",
  SAML_GROUPS_ATTR:
    "Optional groups attribute name. Blank tries Entra/Google defaults (groups / role claims).",
  SAML_ADMIN_GROUP:
    "If any group equals this value (case-insensitive), the user becomes an administrator.",
  LDAP_ENABLED:
    "Allow domain password login for usernames that are not local accounts. Existing local users always win.",
  LDAP_URL: "Prefer ldaps://dc.example.com:636. The orchestrator host must reach the domain controller.",
  LDAP_BIND_DN: "Service account DN used only to search for the user (e.g. CN=rbi-svc,OU=…,DC=…).",
  LDAP_BIND_PASSWORD: "Password for the LDAP bind DN. Stored in portal settings like other secrets.",
  LDAP_SEARCH_BASE: "Where to search for users, usually the domain root DN.",
  LDAP_SEARCH_FILTER:
    "Must include {{username}}. Blank defaults to sAMAccountName or userPrincipalName match.",
  LDAP_USERNAME_ATTR: "Display username attribute. Blank defaults to sAMAccountName.",
  LDAP_GROUPS_ATTR: "Group membership attribute. Blank defaults to memberOf.",
  LDAP_ADMIN_GROUP:
    "CN names (comma-separated) or full DNs (use semicolons between DNs). Membership grants admin.",
  LDAP_TLS_REJECT_UNAUTHORIZED:
    "Keep true in production. Set false only for lab DCs with self-signed LDAPS certificates.",
};

const SP_HELP = {
  acsUrl: "Paste into your IdP as ACS URL / Reply URL / Assertion Consumer Service.",
  metadataUrl: "Optional: import this URL (or its XML) when the IdP supports SP metadata.",
  entityId: "Paste into your IdP as Entity ID / Identifier / Audience.",
  nameId: "Prefer email Name ID in the IdP app. Format expected by this portal.",
} as const;

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function ssoUrlsFrom(draft: Record<string, string>) {
  const base = trimBase(draft.PUBLIC_BASE_URL ?? "");
  if (!base) {
    return {
      ready: false as const,
      acsUrl: "Set Public base URL first",
      metadataUrl: "Set Public base URL first",
      entityId: "Set Public base URL first",
    };
  }
  const metadataUrl = `${base}/saml/metadata`;
  const customEntity = (draft.SAML_SP_ENTITY_ID ?? "").trim();
  return {
    ready: true as const,
    acsUrl: `${base}/api/auth/saml/acs`,
    metadataUrl,
    entityId: customEntity || metadataUrl,
  };
}

function boolLabel(value: string | undefined, on: string, off: string): string {
  return value === "true" ? on : off;
}

function pickFields(editable: AdminSettingField[] | null, keys: readonly string[]): AdminSettingField[] {
  if (!editable) return [];
  const byKey = new Map(editable.map((field) => [field.key, field]));
  return keys.map((key) => byKey.get(key)).filter((field): field is AdminSettingField => Boolean(field));
}

type LdapChecklistItem = { id: string; label: string; ok: boolean; detail: string };

function ldapChecklist(draft: Record<string, string>): {
  ready: boolean;
  enabled: boolean;
  items: LdapChecklistItem[];
} {
  const url = (draft.LDAP_URL ?? "").trim();
  const bindDn = (draft.LDAP_BIND_DN ?? "").trim();
  const password = draft.LDAP_BIND_PASSWORD ?? "";
  const searchBase = (draft.LDAP_SEARCH_BASE ?? "").trim();
  const filter = (draft.LDAP_SEARCH_FILTER ?? "").trim();
  const items: LdapChecklistItem[] = [
    {
      id: "url",
      label: "LDAP URL",
      ok: Boolean(url) && /^ldaps?:\/\//i.test(url),
      detail: url
        ? /^ldaps?:\/\//i.test(url)
          ? url
          : "Must start with ldap:// or ldaps://"
        : "Required — prefer ldaps://dc.example.com:636",
    },
    {
      id: "bindDn",
      label: "Bind DN",
      ok: Boolean(bindDn),
      detail: bindDn || "Service account DN required",
    },
    {
      id: "bindPassword",
      label: "Bind password",
      ok: Boolean(password),
      detail: password ? "Set" : "Required",
    },
    {
      id: "searchBase",
      label: "Search base",
      ok: Boolean(searchBase),
      detail: searchBase || "Required — e.g. DC=corp,DC=example,DC=com",
    },
    {
      id: "searchFilter",
      label: "Search filter",
      ok: !filter || filter.includes("{{username}}"),
      detail: filter
        ? filter.includes("{{username}}")
          ? "Custom filter OK"
          : 'Must include "{{username}}"'
        : "Using default sAMAccountName / UPN match",
    },
  ];
  return {
    ready: items.every((item) => item.ok),
    enabled: (draft.LDAP_ENABLED ?? "false") === "true",
    items,
  };
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip">
      <button type="button" className="help-tip-btn" aria-label="More info">
        ?
      </button>
      <span className="help-tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function SignInSection({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section className="signin-section">
      <header className="signin-section-head">
        <p className="signin-section-eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
        <p className="signin-section-summary">{summary}</p>
      </header>
      <div className="signin-section-body">{children}</div>
    </section>
  );
}

function CopyRow({
  label,
  value,
  help,
  copyable,
}: {
  label: string;
  value: string;
  help: string;
  copyable: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="copy-row">
      <div className="copy-row-label">
        <span>{label}</span>
        <HelpTip text={help} />
      </div>
      <div className="copy-row-value">
        <code title={value}>{value}</code>
        <button
          type="button"
          className="copy-row-btn"
          disabled={!copyable}
          onClick={() => void onCopy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function SettingsCard({
  title,
  hint,
  status,
  onConfigure,
  media,
}: {
  title: string;
  hint: string;
  status: string[];
  onConfigure: () => void;
  media?: ReactNode;
}) {
  return (
    <article className="settings-card">
      <div className="settings-card-main">
        <div className="settings-card-copy">
          <h2>{title}</h2>
          <p className="hint">{hint}</p>
          {status.length ? (
            <div className="settings-card-status">
              {status.map((item) => (
                <span key={item} className="settings-status-pill">
                  {item}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {media ? <div className="settings-card-media">{media}</div> : null}
      </div>
      <button type="button" className="settings-card-configure" onClick={onConfigure}>
        Configure
      </button>
    </article>
  );
}

function SettingsModal({
  title,
  hint,
  busy,
  dirty,
  error,
  message,
  onClose,
  onSave,
  children,
  wide,
  busyLabel = "Saving…",
}: {
  title: string;
  hint?: string;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  message: string | null;
  onClose: () => void;
  onSave: () => void;
  children: ReactNode;
  wide?: boolean;
  busyLabel?: string;
}) {
  const titleId = useId();

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <div
        className={`modal-panel modal-panel-sso${wide ? " modal-panel-settings-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-panel-sso-body">
          <div className="panel-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              {hint ? <p className="hint">{hint}</p> : null}
            </div>
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          {message ? <p className="settings-saved">{message}</p> : null}
          {children}
        </div>
        <div className="modal-panel-sso-footer">
          <button type="button" className="button-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={busy || !dirty}
            onClick={onSave}
          >
            {busy ? busyLabel : dirty ? "Save changes" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { me, onMe } = useAdminContext();
  const [editable, setEditable] = useState<AdminSettingField[] | null>(null);
  const [ldapTestUsername, setLdapTestUsername] = useState("");
  const [ldapTesting, setLdapTesting] = useState(false);
  const [ldapTestResult, setLdapTestResult] = useState<LdapTestResult | null>(null);
  const [readonly, setReadonly] = useState<AdminReadonlySetting[] | null>(null);
  const [live, setLive] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [hubMessage, setHubMessage] = useState<string | null>(null);

  const [activeModal, setActiveModal] = useState<ModalId | null>(null);
  const [modalDraft, setModalDraft] = useState<Record<string, string>>({});
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalMessage, setModalMessage] = useState<string | null>(null);
  const [savingModal, setSavingModal] = useState(false);

  const [auditCatalog, setAuditCatalog] = useState<AdminAuditActionDef[]>([]);
  const [auditDraft, setAuditDraft] = useState<Set<string>>(new Set());
  const [auditSaved, setAuditSaved] = useState<Set<string>>(new Set());

  const [logo, setLogo] = useState<BrandingLogo | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    const [result, audit, branding] = await Promise.all([
      getAdminSettings(),
      getAdminAudit({ limit: 1 }),
      getAdminBranding(),
    ]);
    setEditable(result.editable);
    setReadonly(result.readonly);
    const next: Record<string, string> = {};
    for (const field of result.editable) next[field.key] = field.value;
    setLive(next);
    setAuditCatalog(audit.catalog);
    const enabled = new Set(audit.enabledActions);
    setAuditSaved(enabled);
    setAuditDraft(new Set(enabled));
    setLogo(branding.logo);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load admin data.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadSettings]);

  const samlFields = useMemo(() => pickFields(editable, SAML_KEYS), [editable]);
  const ldapFields = useMemo(() => pickFields(editable, LDAP_KEYS), [editable]);
  const brandingFields = useMemo(() => pickFields(editable, SECTION_KEYS.branding), [editable]);
  const securityFields = useMemo(() => pickFields(editable, SECTION_KEYS.security), [editable]);
  const sessionsFields = useMemo(() => pickFields(editable, SECTION_KEYS.sessions), [editable]);
  const browserFields = useMemo(() => pickFields(editable, SECTION_KEYS.browser), [editable]);
  const streamingFields = useMemo(() => pickFields(editable, SECTION_KEYS.streaming), [editable]);
  const advancedFields = useMemo(() => pickFields(editable, SECTION_KEYS.advanced), [editable]);

  const auditDirty = useMemo(() => {
    if (auditDraft.size !== auditSaved.size) return true;
    for (const id of auditDraft) {
      if (!auditSaved.has(id)) return true;
    }
    return false;
  }, [auditDraft, auditSaved]);

  const modalDirtyKeys = useMemo(() => {
    if (!activeModal || activeModal === "audit") return [] as string[];
    const keys =
      activeModal === "sso" ? SSO_KEYS : SECTION_KEYS[activeModal as Exclude<ModalId, "sso" | "audit">];
    return keys.filter((key) => (modalDraft[key] ?? "") !== (live[key] ?? ""));
  }, [activeModal, live, modalDraft]);

  const modalDirty = activeModal === "audit" ? auditDirty : modalDirtyKeys.length > 0;
  const ssoUrls = useMemo(() => ssoUrlsFrom(modalDraft), [modalDraft]);
  const ldapDraftStatus = useMemo(() => ldapChecklist(modalDraft), [modalDraft]);
  const ssoEnabled = (live.SAML_ENABLED ?? "false") === "true";
  const ldapLiveStatus = useMemo(() => ldapChecklist(live), [live]);
  const ldapEnabled = ldapLiveStatus.enabled;
  const auditEnabledCount = auditSaved.size;
  const auditTotalCount = auditCatalog.length || auditSaved.size;
  const modalBusy = savingModal || logoBusy || ldapTesting;

  function openSectionModal(id: Exclude<ModalId, "audit">) {
    const keys = id === "sso" ? SSO_KEYS : SECTION_KEYS[id];
    const next: Record<string, string> = {};
    for (const key of keys) next[key] = live[key] ?? "";
    setModalDraft(next);
    setModalError(null);
    setModalMessage(null);
    setLdapTestResult(null);
    setLdapTestUsername("");
    setActiveModal(id);
  }

  function openAuditModal() {
    setAuditDraft(new Set(auditSaved));
    setModalError(null);
    setModalMessage(null);
    setActiveModal("audit");
  }

  function closeModal() {
    if (modalBusy) return;
    if (modalDirty && !window.confirm("Discard unsaved changes?")) return;
    setActiveModal(null);
    setModalError(null);
    setModalMessage(null);
    setLdapTestResult(null);
  }

  useEffect(() => {
    if (!activeModal) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (modalBusy) return;
      if (modalDirty && !window.confirm("Discard unsaved changes?")) return;
      setActiveModal(null);
      setModalError(null);
      setModalMessage(null);
      setLdapTestResult(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeModal, modalBusy, modalDirty]);

  function toggleAuditAction(id: string) {
    setAuditDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAuditCategory(category: "admin" | "user", enabled: boolean) {
    setAuditDraft((prev) => {
      const next = new Set(prev);
      for (const item of auditCatalog) {
        if (item.category !== category) continue;
        if (enabled) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
      reader.readAsDataURL(file);
    });
  }

  async function onUploadLogo(file: File | null) {
    if (!file) return;
    setLogoBusy(true);
    setModalError(null);
    setModalMessage(null);
    try {
      const data = await fileToBase64(file);
      const result = await uploadAdminLogo(
        { contentType: file.type || "image/png", data, filename: file.name },
        me.csrfToken,
      );
      setLogo(result.logo);
      onMe({ ...me, logoUrl: result.logo.url });
      setModalMessage("Logo uploaded.");
      setHubMessage("Site logo updated.");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "unsupported_logo_type") {
          setModalError("Use a PNG, JPEG, WebP, or GIF image.");
        } else if (err.code === "logo_too_large") {
          setModalError("Logo must be 1 MB or smaller.");
        } else {
          setModalError(err.message && err.message !== err.code ? err.message : "Unable to upload logo.");
        }
      } else {
        setModalError("Unable to upload logo.");
      }
    } finally {
      setLogoBusy(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  }

  async function onRemoveLogo() {
    setLogoBusy(true);
    setModalError(null);
    setModalMessage(null);
    try {
      await deleteAdminLogo(me.csrfToken);
      setLogo(null);
      onMe({ ...me, logoUrl: null });
      setModalMessage("Custom logo removed.");
      setHubMessage("Custom logo removed.");
    } catch {
      setModalError("Unable to remove logo.");
    } finally {
      setLogoBusy(false);
    }
  }

  async function applyLiveFromResult(result: {
    editable: AdminSettingField[];
    readonly: AdminReadonlySetting[];
  }) {
    setEditable(result.editable);
    setReadonly(result.readonly);
    const next: Record<string, string> = {};
    for (const field of result.editable) next[field.key] = field.value;
    setLive(next);
    return next;
  }

  async function onSaveSection() {
    if (!activeModal || activeModal === "audit") return;
    if (modalDirtyKeys.length === 0) {
      setModalMessage("No changes to save.");
      return;
    }
    if (activeModal === "sso") {
      const ldapStatus = ldapChecklist(modalDraft);
      if (ldapStatus.enabled && !ldapStatus.ready) {
        setModalError(
          "LDAP is enabled but incomplete. Fill every required LDAP field (or turn LDAP off), then Save.",
        );
        return;
      }
    }
    setSavingModal(true);
    setModalError(null);
    setModalMessage(null);
    const patch: Record<string, string> = {};
    for (const key of modalDirtyKeys) patch[key] = modalDraft[key] ?? "";
    try {
      const result = await updateAdminSettings(patch, me.csrfToken);
      const next = await applyLiveFromResult(result);
      const refreshed: Record<string, string> = {};
      const keys =
        activeModal === "sso" ? SSO_KEYS : SECTION_KEYS[activeModal as Exclude<ModalId, "sso" | "audit">];
      for (const key of keys) refreshed[key] = next[key] ?? "";
      setModalDraft(refreshed);

      const siteName = next.SITE_NAME?.trim();
      if (siteName && siteName !== me.siteName) {
        onMe({ ...me, siteName });
        document.title = siteName;
      }

      const label =
        activeModal === "sso"
          ? "Sign-in"
          : activeModal === "branding"
            ? "Branding"
            : activeModal === "security"
              ? "Security"
              : activeModal === "sessions"
                ? "Sessions"
                : activeModal === "browser"
                  ? "Browser capacity"
                  : activeModal === "streaming"
                    ? "Streaming"
                    : "Advanced";
      const ldapLiveOn = (next.LDAP_ENABLED ?? "false") === "true";
      const ldapNote =
        activeModal === "sso"
          ? ldapLiveOn
            ? " LDAP is ON and saved — domain passwords work for usernames that are not local accounts."
            : " LDAP is OFF and saved."
          : "";
      setModalMessage(`Saved ${result.updated.length} setting(s).${ldapNote}`);
      setHubMessage(
        activeModal === "sso"
          ? `Sign-in settings saved · LDAP ${ldapLiveOn ? "on" : "off"}`
          : `${label} settings saved.`,
      );
      setLdapTestResult(null);
    } catch (err) {
      setModalError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to save settings.",
      );
    } finally {
      setSavingModal(false);
    }
  }

  async function onTestLdap() {
    if (activeModal !== "sso") return;
    const status = ldapChecklist(modalDraft);
    if (!status.ready) {
      setModalError("Fill the required LDAP fields before testing.");
      setLdapTestResult(null);
      return;
    }
    setLdapTesting(true);
    setModalError(null);
    setModalMessage(null);
    setLdapTestResult(null);
    const settings: Record<string, string> = {};
    for (const key of LDAP_KEYS) settings[key] = modalDraft[key] ?? "";
    try {
      const result = await testAdminLdapSettings(
        {
          settings,
          username: ldapTestUsername.trim() || undefined,
        },
        me.csrfToken,
      );
      setLdapTestResult(result);
      if (result.ok) {
        setModalMessage(result.message);
      } else {
        setModalError(result.message);
      }
    } catch (err) {
      setLdapTestResult(null);
      setModalError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to test LDAP settings.",
      );
    } finally {
      setLdapTesting(false);
    }
  }

  async function onSaveAudit() {
    if (!auditDirty) {
      setModalMessage("No audit logging changes to save.");
      return;
    }
    setSavingModal(true);
    setModalError(null);
    setModalMessage(null);
    const enabled = auditCatalog.map((item) => item.id).filter((id) => auditDraft.has(id));
    try {
      const result = await updateAdminSettings(
        { AUDIT_ENABLED_ACTIONS: JSON.stringify(enabled) },
        me.csrfToken,
      );
      await applyLiveFromResult(result);
      const saved = new Set(enabled);
      setAuditSaved(saved);
      setAuditDraft(new Set(saved));
      setModalMessage(`Saved ${enabled.length} logged action(s).`);
      setHubMessage("Audit logging settings saved.");
    } catch (err) {
      setModalError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to save audit settings.",
      );
    } finally {
      setSavingModal(false);
    }
  }

  function renderField(
    field: AdminSettingField,
    values: Record<string, string>,
    setValues: (updater: (prev: Record<string, string>) => Record<string, string>) => void,
    disabled: boolean,
  ): ReactNode {
    const value = values[field.key] ?? field.value;
    const common = {
      id: `setting-${field.key}`,
      disabled,
    };

    if (field.type === "boolean") {
      return (
        <label className="settings-check" htmlFor={common.id}>
          <input
            {...common}
            type="checkbox"
            checked={value === "true"}
            onChange={(event) =>
              setValues((prev) => ({
                ...prev,
                [field.key]: event.target.checked ? "true" : "false",
              }))
            }
          />
          <span>
            {field.key === "LDAP_TLS_REJECT_UNAUTHORIZED"
              ? "Reject unauthorized certificates"
              : "Enabled"}
          </span>
        </label>
      );
    }

    if (field.type === "select" && field.options) {
      return (
        <select
          {...common}
          value={value}
          onChange={(event) =>
            setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
          }
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    if (field.type === "json" || field.type === "text") {
      return (
        <textarea
          {...common}
          rows={field.key === "SAML_IDP_CERT" ? 6 : 3}
          value={value}
          onChange={(event) =>
            setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
          }
          spellCheck={false}
        />
      );
    }

    return (
      <input
        {...common}
        type={field.type === "number" ? "number" : field.type === "password" ? "password" : "text"}
        min={field.min}
        max={field.max}
        step={field.key === "BROWSER_CPUS" ? "0.25" : undefined}
        autoComplete={field.type === "password" ? "new-password" : undefined}
        value={value}
        onChange={(event) =>
          setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
        }
      />
    );
  }

  function renderFieldList(fields: AdminSettingField[], options?: { compactHelp?: boolean }) {
    const compactHelp = Boolean(options?.compactHelp);
    return (
      <div className={`settings-grid${compactHelp ? " sso-modal-grid" : ""}`}>
        {fields.map((field) => (
          <div
            key={field.key}
            className={
              field.type === "text" || field.type === "json" || field.key === "SAML_IDP_CERT"
                ? "settings-field settings-field-wide"
                : "settings-field"
            }
          >
            <div className="settings-field-label">
              <label htmlFor={`setting-${field.key}`}>{field.label}</label>
              {compactHelp ? (
                <HelpTip text={SSO_HELP[field.key] ?? field.description} />
              ) : null}
              {field.overridden ? <span className="settings-tag">saved</span> : null}
              {field.appliesToNewSessions ? (
                <span className="settings-tag muted">new sessions</span>
              ) : null}
            </div>
            {compactHelp ? null : <p className="hint">{field.description}</p>}
            {renderField(field, modalDraft, setModalDraft, modalBusy)}
          </div>
        ))}
      </div>
    );
  }

  const brandingStatus = [
    logo ? "Custom logo" : "Default mark",
    live.SITE_NAME?.trim() || "Browser Isolation",
  ];
  const securityStatus = [
    boolLabel(live.ALLOW_CLIPBOARD, "Clipboard on", "Clipboard off"),
    boolLabel(live.ALLOW_DOWNLOADS, "Downloads on", "Downloads off"),
  ];
  const sessionsStatus = [
    `Login ${live.SESSION_TTL_HOURS || "24"}h`,
    `Idle ${live.IDLE_TIMEOUT_MINUTES || "60"}m`,
    `Max ${live.MAX_SESSION_HOURS || "12"}h`,
    boolLabel(live.PERSIST_PROFILES_ENABLED, "Profiles on", "Profiles off"),
  ];
  const browserStatus = [
    `${live.BROWSER_CPUS || "3"} CPU`,
    live.BROWSER_MEMORY || "2g",
    `${live.BROWSER_SHM_SIZE || "2gb"} shm`,
  ];
  const streamingStatus = [
    (live.CAPTURE_VIDEO_CODEC || "h264").toUpperCase(),
    live.DESKTOP_SCREEN || "1280x720@30",
    boolLabel(live.WEBRTC_ICELITE, "ICE lite", "Full ICE"),
  ];
  const advancedStatus = [
    boolLabel(live.TRUST_PROXY, "Trust proxy", "Direct"),
    boolLabel(live.COOKIE_SECURE, "Secure cookies", "HTTP cookies"),
  ];

  return (
    <>
      <section className="card wide settings-hub-page">
        <div className="panel-header">
          <div>
            <h1>Settings</h1>
            <p className="hint">
              Configure branding, access, security, and runtime options. Open a section to review
              and save changes.
            </p>
          </div>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {hubMessage ? <p className="settings-saved">{hubMessage}</p> : null}

        {editable ? (
          <div className="settings-hub">
            <SettingsCard
              title="Branding"
              hint="Site name and logo shown in the portal chrome and login page."
              status={brandingStatus}
              onConfigure={() => openSectionModal("branding")}
              media={
                logo ? (
                  <img className="brand-logo" src={logo.url} alt="" width={36} height={36} />
                ) : (
                  <span className="brand-dot" aria-hidden="true" />
                )
              }
            />
            <SettingsCard
              title="Sign-in"
              hint="Local accounts always work. Optionally add SAML SSO and/or Active Directory LDAP."
              status={[
                "Local on",
                ssoEnabled ? "SSO on" : "SSO off",
                ldapEnabled
                  ? ldapLiveStatus.ready
                    ? "LDAP on"
                    : "LDAP incomplete"
                  : "LDAP off",
              ]}
              onConfigure={() => openSectionModal("sso")}
            />
            <SettingsCard
              title="Security"
              hint="Control clipboard and file transfer between users and isolated browsers."
              status={securityStatus}
              onConfigure={() => openSectionModal("security")}
            />
            <SettingsCard
              title="Sessions"
              hint="Portal login lifetime, persistent profiles, and browser session cleanup."
              status={sessionsStatus}
              onConfigure={() => openSectionModal("sessions")}
            />
            <SettingsCard
              title="Browser capacity"
              hint="CPU, memory, and shared-memory limits for each isolated browser."
              status={browserStatus}
              onConfigure={() => openSectionModal("browser")}
            />
            <SettingsCard
              title="Streaming"
              hint="WebRTC candidates, ICE, desktop geometry, and capture codec."
              status={streamingStatus}
              onConfigure={() => openSectionModal("streaming")}
            />
            <SettingsCard
              title="Audit log"
              hint="Choose which administrator and user actions are recorded."
              status={[
                auditTotalCount
                  ? `${auditEnabledCount}/${auditTotalCount} actions`
                  : `${auditEnabledCount} action(s)`,
              ]}
              onConfigure={openAuditModal}
            />
            <SettingsCard
              title="Advanced"
              hint="Proxy trust, cookie security, and read-only host infrastructure details."
              status={advancedStatus}
              onConfigure={() => openSectionModal("advanced")}
            />
          </div>
        ) : error ? null : (
          <p className="hint">
            <span className="loading-line" aria-hidden="true" /> Loading settings…
          </p>
        )}
      </section>

      {activeModal === "branding" ? (
        <SettingsModal
          title="Branding"
          hint="Update the portal name and optional custom logo."
          busy={savingModal || logoBusy}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
        >
          <div className="branding-modal-layout">
            <div className="branding-modal-preview" aria-hidden="true">
              {logo ? (
                <img className="brand-logo large" src={logo.url} alt="" width={56} height={56} />
              ) : (
                <div className="brand-mark large" />
              )}
              <p className="hint">{logo ? logo.filename : "Default mark"}</p>
            </div>
            <div className="branding-modal-controls">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                hidden
                onChange={(event) => void onUploadLogo(event.target.files?.[0] ?? null)}
              />
              <div className="branding-actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={savingModal || logoBusy}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {logoBusy ? "Working…" : logo ? "Replace logo" : "Upload logo"}
                </button>
                {logo ? (
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={savingModal || logoBusy}
                    onClick={() => void onRemoveLogo()}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <p className="hint">PNG, JPEG, WebP, or GIF up to 1 MB. Logo saves immediately.</p>
            </div>
          </div>
          {renderFieldList(brandingFields)}
        </SettingsModal>
      ) : null}

      {activeModal === "sso" ? (
        <SettingsModal
          title="Sign-in methods"
          hint="Choose how people sign in. You can enable one, both, or neither — local accounts always stay available. Changes apply only after you click Save."
          busy={modalBusy}
          busyLabel={ldapTesting ? "Testing…" : "Saving…"}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
          wide
        >
          <div className="signin-overview">
            <p>
              <strong>Local accounts</strong> are managed under Admin → Users and always work as
              break-glass access.
            </p>
          </div>

          <SignInSection
            eyebrow="Option A"
            title="Single Sign-On (SAML)"
            summary="Shows a “Sign in with SSO” button. Users authenticate at Google, Microsoft Entra, Okta, or another SAML identity provider, then return here. Needs a stable HTTPS portal URL (often a public VIP if users are off-network)."
          >
            <div className="sso-sp-card">
              <p className="sso-sp-heading">
                Values to paste into your IdP
                <HelpTip text="Register this portal in Entra, Google Workspace, or any SAML 2.0 IdP using these service-provider URLs. They are derived from Public base URL below." />
              </p>
              <CopyRow
                label="ACS / Reply URL"
                value={ssoUrls.acsUrl}
                help={SP_HELP.acsUrl}
                copyable={ssoUrls.ready}
              />
              <CopyRow
                label="Metadata URL"
                value={ssoUrls.metadataUrl}
                help={SP_HELP.metadataUrl}
                copyable={ssoUrls.ready}
              />
              <CopyRow
                label="Entity ID / Audience"
                value={ssoUrls.entityId}
                help={SP_HELP.entityId}
                copyable={ssoUrls.ready}
              />
              <CopyRow
                label="Name ID format"
                value="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
                help={SP_HELP.nameId}
                copyable
              />
            </div>
            {renderFieldList(samlFields, { compactHelp: true })}
          </SignInSection>

          <SignInSection
            eyebrow="Option B"
            title="Active Directory (LDAP / LDAPS)"
            summary="Users type their domain username and password on this portal. The server binds to your domain controller. No IdP callback or public VIP is required for LDAP — only network reachability from this host to AD."
          >
            <div
              className={`ldap-status-card${ldapDraftStatus.ready ? " ready" : ""}${ldapDraftStatus.enabled ? " enabled" : ""}`}
            >
              <div className="ldap-status-head">
                <p className="ldap-status-title">LDAP readiness</p>
                <p className="ldap-status-badge">
                  {!ldapDraftStatus.ready
                    ? "Incomplete"
                    : ldapDraftStatus.enabled
                      ? "Ready · will turn ON when saved"
                      : "Ready · currently OFF until you enable + Save"}
                </p>
              </div>
              <ul className="ldap-checklist">
                {ldapDraftStatus.items.map((item) => (
                  <li key={item.id} className={item.ok ? "ok" : "missing"}>
                    <span className="ldap-check-mark" aria-hidden="true">
                      {item.ok ? "✓" : "!"}
                    </span>
                    <span>
                      <strong>{item.label}</strong>
                      <span className="ldap-check-detail">{item.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint ldap-status-hint">
                Checking “Enable LDAP” alone is not enough — fill the fields, use Test settings, then
                click Save. Unsaved edits are discarded if you close this dialog.
              </p>
            </div>

            {renderFieldList(ldapFields, { compactHelp: true })}

            <div className="ldap-test-panel">
              <div className="ldap-test-row">
                <label className="ldap-test-user" htmlFor="ldap-test-username">
                  Optional test username
                  <HelpTip text="If set, the server binds with the service account then searches for this user. It does not try that user’s password." />
                  <input
                    id="ldap-test-username"
                    type="text"
                    value={ldapTestUsername}
                    disabled={modalBusy}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="e.g. jsmith or jsmith@corp.example.com"
                    onChange={(event) => setLdapTestUsername(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={modalBusy || !ldapDraftStatus.ready}
                  onClick={() => void onTestLdap()}
                >
                  {ldapTesting ? "Testing…" : "Test settings"}
                </button>
              </div>
              {ldapTestResult ? (
                <div
                  className={`ldap-test-result${ldapTestResult.ok ? " ok" : " fail"}`}
                  role="status"
                >
                  <p className="ldap-test-summary">{ldapTestResult.message}</p>
                  <ul>
                    {ldapTestResult.steps.map((step) => (
                      <li key={step.id} className={step.ok ? "ok" : "fail"}>
                        <strong>{step.label}</strong>
                        <span>{step.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="hint">
                  Test uses the values currently in this form (even before Save). Save is still
                  required to turn LDAP on for real logins.
                </p>
              )}
            </div>
          </SignInSection>
        </SettingsModal>
      ) : null}

      {activeModal === "security" ? (
        <SettingsModal
          title="Security"
          hint="Data transfer controls between users and isolated browsers."
          busy={savingModal}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
        >
          {renderFieldList(securityFields)}
        </SettingsModal>
      ) : null}

      {activeModal === "sessions" ? (
        <SettingsModal
          title="Sessions"
          hint="Portal login lifetime, profile persistence, and browser session cleanup."
          busy={savingModal}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
        >
          {renderFieldList(sessionsFields)}
        </SettingsModal>
      ) : null}

      {activeModal === "browser" ? (
        <SettingsModal
          title="Browser capacity"
          hint="Resource limits applied when launching a new isolated browser."
          busy={savingModal}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
        >
          {renderFieldList(browserFields)}
        </SettingsModal>
      ) : null}

      {activeModal === "streaming" ? (
        <SettingsModal
          title="Streaming"
          hint="WebRTC and media settings for remote desktop sessions."
          busy={savingModal}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
          wide
        >
          {renderFieldList(streamingFields)}
        </SettingsModal>
      ) : null}

      {activeModal === "advanced" ? (
        <SettingsModal
          title="Advanced"
          hint="Proxy and cookie flags, plus read-only host infrastructure."
          busy={savingModal}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveSection()}
        >
          {renderFieldList(advancedFields)}
          {readonly && readonly.length > 0 ? (
            <div className="settings-group advanced-readonly">
              <div className="settings-group-head">
                <h3>Infrastructure</h3>
                <p className="hint">Read-only values from the host environment. Restart to change.</p>
              </div>
              <div className="settings-grid readonly">
                {readonly.map((field) => (
                  <div key={field.key} className="settings-field">
                    <div className="settings-field-label">
                      <span>{field.label}</span>
                    </div>
                    <p className="hint">{field.description}</p>
                    <code className="settings-readonly-value">{field.value}</code>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </SettingsModal>
      ) : null}

      {activeModal === "audit" ? (
        <SettingsModal
          title="Audit log"
          hint="Select which actions are written to the audit log."
          busy={savingModal}
          dirty={modalDirty}
          error={modalError}
          message={modalMessage}
          onClose={closeModal}
          onSave={() => void onSaveAudit()}
          wide
        >
          {(
            [
              {
                id: "admin" as const,
                title: "Administrators",
                hint: "Joining sessions, terminating sessions, volumes, workers, browsers, and settings.",
              },
              {
                id: "user" as const,
                title: "Users",
                hint: "Account changes, logins, logouts, and browser session lifecycle.",
              },
            ] as const
          ).map((group) => {
            const items = auditCatalog.filter((item) => item.category === group.id);
            if (items.length === 0) return null;
            const enabledInGroup = items.filter((item) => auditDraft.has(item.id)).length;
            return (
              <div key={group.id} className="audit-config-group">
                <div className="audit-config-group-head">
                  <div>
                    <h3>{group.title}</h3>
                    <p className="hint">{group.hint}</p>
                  </div>
                  <div className="audit-config-group-actions">
                    <button
                      type="button"
                      className="button-quiet"
                      disabled={savingModal || enabledInGroup === items.length}
                      onClick={() => setAuditCategory(group.id, true)}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="button-quiet"
                      disabled={savingModal || enabledInGroup === 0}
                      onClick={() => setAuditCategory(group.id, false)}
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="audit-config-list">
                  {items.map((item) => (
                    <label key={item.id} className="audit-config-item">
                      <input
                        type="checkbox"
                        checked={auditDraft.has(item.id)}
                        disabled={savingModal}
                        onChange={() => toggleAuditAction(item.id)}
                      />
                      <span>
                        <strong>{item.label}</strong>
                        <span className="hint">{item.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </SettingsModal>
      ) : null}
    </>
  );
}
