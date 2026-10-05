import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  deleteAdminLogo,
  getAdminAudit,
  getAdminBranding,
  getAdminSettings,
  updateAdminSettings,
  uploadAdminLogo,
  type AdminAuditActionDef,
  type AdminReadonlySetting,
  type AdminSettingField,
  type BrandingLogo,
} from "../../api";
import { useAdminContext } from "./context";

const SETTING_GROUPS: Array<{
  id: Exclude<AdminSettingField["group"], "sso" | "audit">;
  title: string;
  hint: string;
}> = [
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
  { id: "cleanup", title: "Cleanup", hint: "Idle and lifetime limits for browser sessions." },
];

const SSO_KEYS = [
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

/** Short “what to copy / where it comes from” tips for the SSO modal. */
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

export function SettingsPage() {
  const { me, onMe } = useAdminContext();
  const [editable, setEditable] = useState<AdminSettingField[] | null>(null);
  const [readonly, setReadonly] = useState<AdminReadonlySetting[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoDraft, setSsoDraft] = useState<Record<string, string>>({});
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoMessage, setSsoMessage] = useState<string | null>(null);
  const [savingSso, setSavingSso] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditCatalog, setAuditCatalog] = useState<AdminAuditActionDef[]>([]);
  const [auditDraft, setAuditDraft] = useState<Set<string>>(new Set());
  const [auditSaved, setAuditSaved] = useState<Set<string>>(new Set());
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditMessage, setAuditMessage] = useState<string | null>(null);
  const [savingAudit, setSavingAudit] = useState(false);
  const [logo, setLogo] = useState<BrandingLogo | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMessage, setLogoMessage] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
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
    setDraft(next);
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

  const ssoFields = useMemo(
    () => (editable ?? []).filter((field) => field.group === "sso"),
    [editable],
  );

  const dirtyKeys = useMemo(() => {
    if (!editable) return [] as string[];
    return editable
      .filter((field) => field.group !== "sso" && field.group !== "audit")
      .filter((field) => (draft[field.key] ?? "") !== field.value)
      .map((field) => field.key);
  }, [draft, editable]);

  const auditDirty = useMemo(() => {
    if (auditDraft.size !== auditSaved.size) return true;
    for (const id of auditDraft) {
      if (!auditSaved.has(id)) return true;
    }
    return false;
  }, [auditDraft, auditSaved]);

  const auditEnabledCount = auditSaved.size;
  const auditTotalCount = auditCatalog.length || auditSaved.size;

  const ssoDirtyKeys = useMemo(() => {
    return SSO_KEYS.filter((key) => (ssoDraft[key] ?? "") !== (draft[key] ?? ""));
  }, [draft, ssoDraft]);

  const ssoEnabled = (draft.SAML_ENABLED ?? "false") === "true";
  const ssoUrls = useMemo(() => ssoUrlsFrom(ssoDraft), [ssoDraft]);

  function openSsoModal() {
    const next: Record<string, string> = {};
    for (const key of SSO_KEYS) next[key] = draft[key] ?? "";
    setSsoDraft(next);
    setSsoError(null);
    setSsoMessage(null);
    setSsoOpen(true);
  }

  function closeSsoModal() {
    if (savingSso) return;
    setSsoOpen(false);
    setSsoError(null);
    setSsoMessage(null);
  }

  function openAuditModal() {
    setAuditDraft(new Set(auditSaved));
    setAuditError(null);
    setAuditMessage(null);
    setAuditOpen(true);
  }

  function closeAuditModal() {
    if (savingAudit) return;
    setAuditOpen(false);
    setAuditError(null);
    setAuditMessage(null);
  }

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
    setLogoError(null);
    setLogoMessage(null);
    try {
      const data = await fileToBase64(file);
      const result = await uploadAdminLogo(
        { contentType: file.type || "image/png", data, filename: file.name },
        me.csrfToken,
      );
      setLogo(result.logo);
      onMe({ ...me, logoUrl: result.logo.url });
      setLogoMessage("Logo uploaded.");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "unsupported_logo_type") {
          setLogoError("Use a PNG, JPEG, WebP, or GIF image.");
        } else if (err.code === "logo_too_large") {
          setLogoError("Logo must be 1 MB or smaller.");
        } else {
          setLogoError(err.message && err.message !== err.code ? err.message : "Unable to upload logo.");
        }
      } else {
        setLogoError("Unable to upload logo.");
      }
    } finally {
      setLogoBusy(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  }

  async function onRemoveLogo() {
    setLogoBusy(true);
    setLogoError(null);
    setLogoMessage(null);
    try {
      await deleteAdminLogo(me.csrfToken);
      setLogo(null);
      onMe({ ...me, logoUrl: null });
      setLogoMessage("Custom logo removed.");
    } catch {
      setLogoError("Unable to remove logo.");
    } finally {
      setLogoBusy(false);
    }
  }

  async function onSaveSettings() {
    if (dirtyKeys.length === 0) return;
    setSavingSettings(true);
    setSettingsMessage(null);
    setError(null);
    const patch: Record<string, string> = {};
    for (const key of dirtyKeys) patch[key] = draft[key] ?? "";
    try {
      const result = await updateAdminSettings(patch, me.csrfToken);
      setEditable(result.editable);
      setReadonly(result.readonly);
      const next: Record<string, string> = {};
      for (const field of result.editable) next[field.key] = field.value;
      setDraft(next);
      const siteName = next.SITE_NAME?.trim();
      if (siteName && siteName !== me.siteName) {
        onMe({ ...me, siteName });
        document.title = siteName;
      }
      setSettingsMessage(`Saved ${result.updated.length} setting(s).`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to save settings.",
      );
    } finally {
      setSavingSettings(false);
    }
  }

  async function onSaveSso() {
    if (ssoDirtyKeys.length === 0) {
      setSsoMessage("No SSO changes to save.");
      return;
    }
    setSavingSso(true);
    setSsoMessage(null);
    setSsoError(null);
    const patch: Record<string, string> = {};
    for (const key of ssoDirtyKeys) patch[key] = ssoDraft[key] ?? "";
    try {
      const result = await updateAdminSettings(patch, me.csrfToken);
      setEditable(result.editable);
      setReadonly(result.readonly);
      const next: Record<string, string> = {};
      for (const field of result.editable) next[field.key] = field.value;
      setDraft(next);
      const refreshed: Record<string, string> = {};
      for (const key of SSO_KEYS) refreshed[key] = next[key] ?? "";
      setSsoDraft(refreshed);
      setSsoMessage(`Saved ${result.updated.length} SSO setting(s).`);
      setSettingsMessage(`Saved ${result.updated.length} SSO setting(s).`);
    } catch (err) {
      setSsoError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to save SSO settings.",
      );
    } finally {
      setSavingSso(false);
    }
  }

  async function onSaveAudit() {
    if (!auditDirty) {
      setAuditMessage("No audit logging changes to save.");
      return;
    }
    setSavingAudit(true);
    setAuditMessage(null);
    setAuditError(null);
    const enabled = auditCatalog.map((item) => item.id).filter((id) => auditDraft.has(id));
    try {
      const result = await updateAdminSettings(
        { AUDIT_ENABLED_ACTIONS: JSON.stringify(enabled) },
        me.csrfToken,
      );
      setEditable(result.editable);
      setReadonly(result.readonly);
      const next: Record<string, string> = {};
      for (const field of result.editable) next[field.key] = field.value;
      setDraft(next);
      const saved = new Set(enabled);
      setAuditSaved(saved);
      setAuditDraft(new Set(saved));
      setAuditMessage(`Saved ${enabled.length} logged action(s).`);
      setSettingsMessage("Audit logging settings saved.");
    } catch (err) {
      setAuditError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Unable to save audit settings.",
      );
    } finally {
      setSavingAudit(false);
    }
  }

  function renderField(
    field: AdminSettingField,
    values: Record<string, string>,
    setValues: (updater: (prev: Record<string, string>) => Record<string, string>) => void,
    disabled: boolean,
    opts?: { compact?: boolean },
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
          <span>Enabled</span>
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
        type={field.type === "number" ? "number" : "text"}
        min={field.min}
        max={field.max}
        step={field.key === "BROWSER_CPUS" ? "0.25" : undefined}
        value={value}
        placeholder={opts?.compact ? undefined : undefined}
        onChange={(event) =>
          setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
        }
      />
    );
  }

  return (
    <>
      <section className="card wide">
        <div className="panel-header">
          <div>
            <h1>Settings</h1>
            <p className="hint">
              Runtime options for the portal. Changes save to the database and apply immediately
              where possible.
            </p>
          </div>
          <button
            type="button"
            className="button-primary"
            disabled={savingSettings || dirtyKeys.length === 0}
            onClick={() => void onSaveSettings()}
          >
            {savingSettings
              ? "Saving…"
              : dirtyKeys.length
                ? `Save ${dirtyKeys.length} change(s)`
                : "No changes"}
          </button>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {settingsMessage ? <p className="settings-saved">{settingsMessage}</p> : null}

        {editable ? (
          <div className="settings-stack">
            <div className="branding-card">
              <div className="branding-card-copy">
                <h2>Site logo</h2>
                <p className="hint">
                  Shown in the top bar and on the login page. PNG, JPEG, WebP, or GIF up to 1 MB.
                </p>
                {logoError ? (
                  <p className="alert" role="alert">
                    {logoError}
                  </p>
                ) : null}
                {logoMessage ? <p className="settings-saved">{logoMessage}</p> : null}
                <div className="branding-actions">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                    hidden
                    onChange={(event) => void onUploadLogo(event.target.files?.[0] ?? null)}
                  />
                  <button
                    type="button"
                    className="button-primary"
                    disabled={logoBusy}
                    onClick={() => logoInputRef.current?.click()}
                  >
                    {logoBusy ? "Working…" : logo ? "Replace logo" : "Upload logo"}
                  </button>
                  {logo ? (
                    <button
                      type="button"
                      className="button-quiet"
                      disabled={logoBusy}
                      onClick={() => void onRemoveLogo()}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="branding-preview" aria-hidden="true">
                {logo ? (
                  <img className="brand-logo large" src={logo.url} alt="" width={56} height={56} />
                ) : (
                  <div className="brand-mark large" />
                )}
              </div>
            </div>

            <div className="sso-summary">
              <div className="sso-summary-copy">
                <div className="sso-summary-title">
                  <h2>SSO / SAML</h2>
                  <span className={ssoEnabled ? "session-pill" : "session-pill idle"}>
                    {ssoEnabled ? "On" : "Off"}
                  </span>
                </div>
                <p className="hint">
                  Connect Google, Microsoft Entra, or any SAML 2.0 IdP. Local login stays available.
                </p>
              </div>
              <button type="button" className="sso-configure" onClick={openSsoModal}>
                Configure
              </button>
            </div>

            <div className="sso-summary">
              <div className="sso-summary-copy">
                <div className="sso-summary-title">
                  <h2>Audit log</h2>
                  <span className="session-pill idle">
                    {auditTotalCount
                      ? `${auditEnabledCount}/${auditTotalCount} actions`
                      : `${auditEnabledCount} action(s)`}
                  </span>
                </div>
                <p className="hint">
                  Choose which administrator and user actions are recorded in the audit log.
                </p>
              </div>
              <button type="button" className="sso-configure" onClick={openAuditModal}>
                Configure
              </button>
            </div>

            {SETTING_GROUPS.map((group) => {
              const fields = editable.filter((field) => field.group === group.id);
              if (fields.length === 0) return null;
              return (
                <div key={group.id} className="settings-group">
                  <div className="settings-group-head">
                    <h2>{group.title}</h2>
                    <p className="hint">{group.hint}</p>
                  </div>
                  <div className="settings-grid">
                    {fields.map((field) => (
                      <div key={field.key} className="settings-field">
                      <div className="settings-field-label">
                        <label htmlFor={`setting-${field.key}`}>{field.label}</label>
                        {field.overridden ? <span className="settings-tag">saved</span> : null}
                        {field.appliesToNewSessions ? (
                          <span className="settings-tag muted">new sessions</span>
                        ) : null}
                      </div>
                      <p className="hint">{field.description}</p>
                      {renderField(field, draft, setDraft, savingSettings)}
                    </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {readonly && readonly.length > 0 ? (
              <div className="settings-group">
                <div className="settings-group-head">
                  <h2>Infrastructure</h2>
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
          </div>
        ) : error ? null : (
          <p className="hint">
            <span className="loading-line" aria-hidden="true" /> Loading settings…
          </p>
        )}
      </section>

      {ssoOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeSsoModal}>
          <div
            className="modal-panel modal-panel-sso"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sso-config-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-panel-sso-body">
              <div className="panel-header">
                <div>
                  <h2 id="sso-config-title">SSO / SAML</h2>
                </div>
                <button
                  type="button"
                  className="modal-close"
                  onClick={closeSsoModal}
                  disabled={savingSso}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {ssoError ? (
                <p className="alert" role="alert">
                  {ssoError}
                </p>
              ) : null}
              {ssoMessage ? <p className="settings-saved">{ssoMessage}</p> : null}

              <div className="sso-sp-card">
                <p className="sso-sp-heading">
                  Values to paste into your IdP
                  <HelpTip text="Register this portal in Entra, Google Workspace, or any SAML 2.0 IdP using these service-provider URLs." />
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

              <div className="settings-grid sso-modal-grid">
                {ssoFields.map((field) => (
                  <div
                    key={field.key}
                    className={
                      field.type === "text" || field.key === "SAML_IDP_CERT"
                        ? "settings-field settings-field-wide"
                        : "settings-field"
                    }
                  >
                    <div className="settings-field-label">
                      <label htmlFor={`setting-${field.key}`}>{field.label}</label>
                      <HelpTip text={SSO_HELP[field.key] ?? field.description} />
                      {field.overridden ? <span className="settings-tag">override</span> : null}
                    </div>
                    {renderField(field, ssoDraft, setSsoDraft, savingSso, { compact: true })}
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-panel-sso-footer">
              <button type="button" className="button-quiet" onClick={closeSsoModal} disabled={savingSso}>
                Cancel
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={savingSso || ssoDirtyKeys.length === 0}
                onClick={() => void onSaveSso()}
              >
                {savingSso
                  ? "Saving…"
                  : ssoDirtyKeys.length
                    ? `Save ${ssoDirtyKeys.length} change(s)`
                    : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {auditOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeAuditModal}>
          <div
            className="modal-panel modal-panel-sso"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-config-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-panel-sso-body">
              <div className="panel-header">
                <div>
                  <h2 id="audit-config-title">Audit log</h2>
                  <p className="hint">Select which actions are written to the audit log.</p>
                </div>
                <button
                  type="button"
                  className="modal-close"
                  onClick={closeAuditModal}
                  disabled={savingAudit}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {auditError ? (
                <p className="alert" role="alert">
                  {auditError}
                </p>
              ) : null}
              {auditMessage ? <p className="settings-saved">{auditMessage}</p> : null}

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
                          disabled={savingAudit || enabledInGroup === items.length}
                          onClick={() => setAuditCategory(group.id, true)}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={savingAudit || enabledInGroup === 0}
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
                            disabled={savingAudit}
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
            </div>

            <div className="modal-panel-sso-footer">
              <button
                type="button"
                className="button-quiet"
                onClick={closeAuditModal}
                disabled={savingAudit}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={savingAudit || !auditDirty}
                onClick={() => void onSaveAudit()}
              >
                {savingAudit ? "Saving…" : auditDirty ? "Save changes" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
