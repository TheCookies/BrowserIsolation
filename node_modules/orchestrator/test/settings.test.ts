import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultAuditEnabledActions } from "../src/audit-store";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { applySettingToConfig, createSettingsStore } from "../src/settings-store";

function baseConfig(dir: string): Config {
  return {
    host: "127.0.0.1",
    port: 8080,
    siteName: "Browser Isolation",
    trustProxy: false,
    cookieSecure: false,
    cookieName: "rbi_session",
    csrfCookieName: "rbi_csrf",
    sessionTtlMs: 24 * 60 * 60 * 1000,
    databasePath: path.join(dir, "rbi.sqlite"),
    staticDir: null,
    authUsers: "admin:admin:admin",
    bcryptRounds: 4,
    enabledBrowsers: ["google-chrome", "firefox", "brave"],
    nekoImageTag: "test",
    browserNetwork: "rbi-browsers",
    browserShmSizeBytes: 2 * 1024 ** 3,
    browserNanoCpus: 3e9,
    browserMemoryBytes: 2 * 1024 ** 3,
    publicIp: "127.0.0.1",
    webrtcPortStart: 52000,
    webrtcPortEnd: 52099,
    webrtcIceLite: true,
    iceServersFrontend: "[]",
    iceServersBackend: "[]",
    desktopScreen: "1280x720@30",
    captureVideoCodec: "vp8",
    dockerSocketPath: "/var/run/docker.sock",
    nekoPoliciesDir: "/tmp/neko-policies-unused",
    persistProfilesEnabled: true,
    profileDataDir: "",
    allowClipboard: false,
    allowDownloads: false,
    localWorkerEnabled: true,
    workersBootstrap: "",
    workerEnrollToken: "",
    publicBaseUrl: "",
    samlEnabled: false,
    samlEntryPoint: "",
    samlIdpEntityId: "",
    samlIdpCert: "",
    samlSpEntityId: "",
    samlUsernameAttr: "",
    samlGroupsAttr: "",
    samlAdminGroup: "",
    ldapEnabled: false,
    ldapUrl: "",
    ldapBindDn: "",
    ldapBindPassword: "",
    ldapSearchBase: "",
    ldapSearchFilter: "",
    ldapUsernameAttr: "",
    ldapGroupsAttr: "",
    ldapAdminGroup: "",
    ldapTlsRejectUnauthorized: true,
    auditEnabledActions: defaultAuditEnabledActions(),
    idleTimeoutMinutes: 60,
    maxSessionHours: 12,
    reaperIntervalSeconds: 60,
  };
}

test("settings store validates, persists, and hydrates overrides", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-settings-"));
  try {
    const config = baseConfig(dir);
    const db = openDatabase(config.databasePath);
    const settings = createSettingsStore(db, config);

    assert.throws(() => settings.update({ DESKTOP_SCREEN: "nope" }), /1280x720/);
    assert.equal(config.desktopScreen, "1280x720@30");

    const result = settings.update({
      PUBLIC_IP: "10.0.0.9",
      BROWSER_CPUS: "4",
      PERSIST_PROFILES_ENABLED: "false",
    });
    assert.deepEqual(result.updated.sort(), [
      "BROWSER_CPUS",
      "PERSIST_PROFILES_ENABLED",
      "PUBLIC_IP",
    ]);
    assert.equal(config.publicIp, "10.0.0.9");
    assert.equal(config.browserNanoCpus, 4e9);
    assert.equal(config.persistProfilesEnabled, false);

    const fresh = baseConfig(dir);
    const again = createSettingsStore(db, fresh);
    again.hydrateConfig();
    assert.equal(fresh.publicIp, "10.0.0.9");
    assert.equal(fresh.browserNanoCpus, 4e9);
    assert.equal(fresh.persistProfilesEnabled, false);

    const listed = again.list();
    assert.ok(listed.editable.some((field) => field.key === "PUBLIC_IP" && field.overridden));
    assert.ok(listed.readonly.some((field) => field.key === "WEBRTC_PORT_RANGE"));

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applySettingToConfig rejects bad codec", () => {
  const config = baseConfig("/tmp");
  assert.throws(() => applySettingToConfig(config, "CAPTURE_VIDEO_CODEC", "av1"), /vp8/);
});

test("LDAP settings round-trip through the settings store", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-settings-ldap-"));
  try {
    const config = baseConfig(dir);
    const db = openDatabase(config.databasePath);
    const settings = createSettingsStore(db, config);

    assert.throws(() => applySettingToConfig(config, "LDAP_URL", "dc.example.com"), /ldap:\/\//);

    settings.update({
      LDAP_ENABLED: "true",
      LDAP_URL: "ldaps://dc.example.com:636",
      LDAP_BIND_DN: "CN=svc,DC=example,DC=com",
      LDAP_BIND_PASSWORD: "s3cret",
      LDAP_SEARCH_BASE: "DC=example,DC=com",
      LDAP_ADMIN_GROUP: "Portal Admins,Domain Admins",
      LDAP_TLS_REJECT_UNAUTHORIZED: "false",
    });
    assert.equal(config.ldapEnabled, true);
    assert.equal(config.ldapUrl, "ldaps://dc.example.com:636");
    assert.equal(config.ldapBindPassword, "s3cret");
    assert.equal(config.ldapAdminGroup, "Portal Admins,Domain Admins");
    assert.equal(config.ldapTlsRejectUnauthorized, false);

    const fresh = baseConfig(dir);
    createSettingsStore(db, fresh).hydrateConfig();
    assert.equal(fresh.ldapEnabled, true);
    assert.equal(fresh.ldapBindDn, "CN=svc,DC=example,DC=com");
    assert.equal(fresh.ldapTlsRejectUnauthorized, false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security settings default to disallow and persist when enabled", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-settings-sec-"));
  try {
    const config = baseConfig(dir);
    assert.equal(config.allowClipboard, false);
    assert.equal(config.allowDownloads, false);

    const db = openDatabase(config.databasePath);
    const settings = createSettingsStore(db, config);
    const listed = settings.list();
    assert.ok(
      listed.editable.some(
        (field) => field.key === "ALLOW_CLIPBOARD" && field.group === "security" && field.value === "false",
      ),
    );
    assert.ok(
      listed.editable.some(
        (field) => field.key === "ALLOW_DOWNLOADS" && field.group === "security" && field.value === "false",
      ),
    );

    settings.update({ ALLOW_CLIPBOARD: "true", ALLOW_DOWNLOADS: "true" });
    assert.equal(config.allowClipboard, true);
    assert.equal(config.allowDownloads, true);

    const fresh = baseConfig(dir);
    const again = createSettingsStore(db, fresh);
    again.hydrateConfig();
    assert.equal(fresh.allowClipboard, true);
    assert.equal(fresh.allowDownloads, true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
