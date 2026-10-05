import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { AuthProvider } from "../src/auth/provider";
import { buildApp } from "../src/app";
import { defaultAuditEnabledActions } from "../src/audit-store";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { createUserPreferencesStore } from "../src/user-preferences";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { createBrowserSessionService } from "../src/browser-sessions";
import type { BrowserContainerInfo, ContainerRuntime } from "../src/docker/container-runtime";
import type { NekoClient } from "../src/neko-client";
import { createSessionStore } from "../src/session-store";
import { sampleSession, testPlacement, testSideChannels } from "./helpers";

const auth: AuthProvider = {
  async authenticate(username, password) {
    if (password !== "secret") return null;
    if (username === "ada") return { username: "ada", role: "admin", subjectId: "local:ada" };
    if (username === "admin") return { username: "admin", role: "user", subjectId: "local:admin" };
    if (username === "gus") return { username: "gus", role: "user", subjectId: "local:gus" };
    return null;
  },
};

function cookiePair(response: LightMyRequestResponse, name: string): string {
  const cookie = response.cookies.find((item) => item.name === name);
  assert.ok(cookie, `missing cookie ${name}`);
  return `${name}=${cookie.value}`;
}

function testConfig(dir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    siteName: "Browser Isolation",
    trustProxy: false,
    cookieSecure: false,
    cookieName: "rbi_session",
    csrfCookieName: "rbi_csrf",
    sessionTtlMs: 60 * 60 * 1000,
    databasePath: path.join(dir, "rbi.sqlite"),
    staticDir: null,
    authUsers: "unused",
    bcryptRounds: 4,
    enabledBrowsers: ["google-chrome", "firefox", "brave"],
    nekoImageTag: "latest",
    browserNetwork: "rbi-browsers",
    browserShmSizeBytes: 2 * 1024 ** 3,
    browserNanoCpus: 1e9,
    browserMemoryBytes: 2 * 1024 ** 3,
    publicIp: "127.0.0.1",
    webrtcPortStart: 52000,
    webrtcPortEnd: 52099,
    webrtcIceLite: true,
    desktopScreen: "1920x1080@30",
    captureVideoCodec: "vp8" as const,
    iceServersFrontend: "[]",
    iceServersBackend: "[]",
    dockerSocketPath: "/var/run/docker.sock",
    nekoPoliciesDir: "/tmp/neko-policies-unused",
    persistProfilesEnabled: true,
    allowClipboard: false,
    allowDownloads: false,
    localWorkerEnabled: true,
    workersBootstrap: "",
    publicBaseUrl: "",
    samlEnabled: false,
    samlEntryPoint: "",
    samlIdpEntityId: "",
    samlIdpCert: "",
    samlSpEntityId: "",
    samlUsernameAttr: "",
    samlGroupsAttr: "",
    samlAdminGroup: "",
    auditEnabledActions: defaultAuditEnabledActions(),
    idleTimeoutMinutes: 60,
    maxSessionHours: 12,
    reaperIntervalSeconds: 60,
  };
}

async function loginAs(app: Awaited<ReturnType<typeof buildHarness>>["app"], username: string) {
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  const body = csrf.json() as { csrfToken: string };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      cookie: cookiePair(csrf, "rbi_csrf"),
      "x-csrf-token": body.csrfToken,
    },
    payload: { username, password: "secret" },
  });
  assert.equal(login.statusCode, 200);
  return {
    cookie: cookiePair(login, "rbi_session"),
    csrfToken: (login.json() as { csrfToken: string }).csrfToken,
  };
}

async function buildHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-admin-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const store = createBrowserSessionStore(db);
  const containers = new Map<string, BrowserContainerInfo>();
  const side = testSideChannels(db, config);

  const runtime: ContainerRuntime = {
    async ensureNetwork() {},
    async createBrowserContainer(input) {
      const info: BrowserContainerInfo = {
        id: `cid-${input.sessionId.slice(0, 8)}`,
        name: `rbi-${input.sessionId.slice(0, 12)}`,
        ipAddress: "10.0.0.9",
        running: true,
        status: "running",
        labels: {},
      };
      containers.set(info.id, info);
      return info;
    },
    async inspect(containerId) {
      return containers.get(containerId) ?? null;
    },
    async stats() {
      return { cpuPercent: 12.5, memoryBytes: 128 * 1024 * 1024 };
    },
    async logs() {
      return "";
    },
    async remove(containerId) {
      containers.delete(containerId);
    },
    async listManaged() {
      return [...containers.values()];
    },
    async listProfileVolumes() {
      return [];
    },
    async removeProfileVolume() {},
    async pullImages(images) {
      return images.map((image) => ({ image, ok: true }));
    },
    async removeImages(images) {
      return images.map((image) => ({ image, ok: true }));
    },
  };

  const neko: NekoClient = {
    async waitUntilReady() {},
    async login() {
      return { token: "neko-token" };
    },
  };

  const { placement, workerStore } = testPlacement(db, config, runtime);
  const browsers = createBrowserSessionService({ config, store, placement, neko, preferences });
  const ownerSession = sampleSession({
    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ownerUsername: "gus",
    containerId: "cid-owner",
    webrtcPort: 52010,
  });
  containers.set(ownerSession.containerId, {
    id: ownerSession.containerId,
    name: ownerSession.containerName,
    ipAddress: "10.0.0.9",
    running: true,
    status: "running",
    labels: {},
  });
  store.insert(ownerSession);
  side.viewers.join(ownerSession.id);

  const app = await buildApp({
    config,
    auth,
    sessions,
    browsers,
    audit: side.audit,
    viewers: side.viewers,
    preferences,
    settings: side.settings,
    localUsers: side.localUsers,
    branding: side.branding,
    runtime,
    placement,
    workerStore,
    logger: false,
  });

  return {
    app,
    config,
    ownerSession,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("non-admin cannot list or terminate sessions", async () => {
  const harness = await buildHarness();
  try {
    const user = await loginAs(harness.app, "gus");
    const list = await harness.app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: user.cookie },
    });
    assert.equal(list.statusCode, 403);

    const terminate = await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${harness.ownerSession.id}`,
      headers: { cookie: user.cookie, "x-csrf-token": user.csrfToken },
    });
    assert.equal(terminate.statusCode, 403);
  } finally {
    await harness.close();
  }
});

test("admin lists sessions with stats, joins with audit, and terminates with audit", async () => {
  const harness = await buildHarness();
  try {
    const admin = await loginAs(harness.app, "ada");

    const list = await harness.app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: admin.cookie },
    });
    assert.equal(list.statusCode, 200);
    const sessions = (list.json() as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.owner, "gus");
    assert.equal(sessions[0]?.viewers, 1);
    assert.equal(sessions[0]?.cpuPercent, 12.5);
    assert.equal(sessions[0]?.memoryBytes, 128 * 1024 * 1024);

    const join = await harness.app.inject({
      method: "POST",
      url: `/api/admin/sessions/${harness.ownerSession.id}/join`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrfToken },
    });
    assert.equal(join.statusCode, 200);
    const access = join.json() as { wsPath: string; password: string };
    assert.match(access.wsPath, /\/view\/ws$/);
    assert.ok(access.password);

    const auditAfterJoin = await harness.app.inject({
      method: "GET",
      url: "/api/admin/audit",
      headers: { cookie: admin.cookie },
    });
    assert.equal(auditAfterJoin.statusCode, 200);
    const events = (auditAfterJoin.json() as { events: Array<{ action: string; actor: string; owner: string }> })
      .events;
    assert.equal(events[0]?.action, "join");
    assert.equal(events[0]?.actor, "ada");
    assert.equal(events[0]?.owner, "gus");

    const terminate = await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${harness.ownerSession.id}`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrfToken },
    });
    assert.equal(terminate.statusCode, 200);
    assert.equal((terminate.json() as { destroyed: boolean }).destroyed, true);

    const listAfter = await harness.app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: admin.cookie },
    });
    assert.equal((listAfter.json() as { sessions: unknown[] }).sessions.length, 0);

    const auditFinal = await harness.app.inject({
      method: "GET",
      url: "/api/admin/audit",
      headers: { cookie: admin.cookie },
    });
    const finalEvents = (auditFinal.json() as { events: Array<{ action: string }> }).events;
    assert.equal(finalEvents[0]?.action, "terminate");
    assert.equal(finalEvents[1]?.action, "join");
  } finally {
    await harness.close();
  }
});

test("admin settings update is audited", async () => {
  const harness = await buildHarness();
  try {
    const admin = await loginAs(harness.app, "ada");
    const update = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: {
        cookie: admin.cookie,
        "x-csrf-token": admin.csrfToken,
        "content-type": "application/json",
      },
      payload: { settings: { ALLOW_CLIPBOARD: "true" } },
    });
    assert.equal(update.statusCode, 200);

    const audit = await harness.app.inject({
      method: "GET",
      url: "/api/admin/audit",
      headers: { cookie: admin.cookie },
    });
    const events = (audit.json() as { events: Array<{ action: string; detail: string | null }> })
      .events;
    assert.equal(events[0]?.action, "update_settings");
    assert.match(events[0]?.detail ?? "", /ALLOW_CLIPBOARD/);
  } finally {
    await harness.close();
  }
});

test("admin audit supports filters and respects enabled-action settings", async () => {
  const harness = await buildHarness();
  try {
    const admin = await loginAs(harness.app, "ada");

    await harness.app.inject({
      method: "POST",
      url: `/api/admin/sessions/${harness.ownerSession.id}/join`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrfToken },
    });

    const filtered = await harness.app.inject({
      method: "GET",
      url: "/api/admin/audit?action=join&actor=ada",
      headers: { cookie: admin.cookie },
    });
    assert.equal(filtered.statusCode, 200);
    const body = filtered.json() as {
      events: Array<{ action: string; actor: string }>;
      catalog: Array<{ id: string }>;
      enabledActions: string[];
    };
    assert.ok(body.catalog.length > 0);
    assert.ok(body.enabledActions.includes("join"));
    assert.ok(body.events.every((event) => event.action === "join" && event.actor === "ada"));
    assert.ok(body.events.length >= 1);

    const disableJoin = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: {
        cookie: admin.cookie,
        "x-csrf-token": admin.csrfToken,
        "content-type": "application/json",
      },
      payload: {
        settings: {
          AUDIT_ENABLED_ACTIONS: JSON.stringify(
            harness.config.auditEnabledActions.filter((action) => action !== "join"),
          ),
        },
      },
    });
    assert.equal(disableJoin.statusCode, 200);

    const before = (
      await harness.app.inject({
        method: "GET",
        url: "/api/admin/audit?action=join",
        headers: { cookie: admin.cookie },
      })
    ).json() as { events: unknown[] };
    const joinCountBefore = before.events.length;

    await harness.app.inject({
      method: "POST",
      url: `/api/admin/sessions/${harness.ownerSession.id}/join`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrfToken },
    });

    const after = (
      await harness.app.inject({
        method: "GET",
        url: "/api/admin/audit?action=join",
        headers: { cookie: admin.cookie },
      })
    ).json() as { events: unknown[] };
    assert.equal(after.events.length, joinCountBefore);
  } finally {
    await harness.close();
  }
});

test("account named admin without admin role is still forbidden", async () => {
  const harness = await buildHarness();
  try {
    const namedAdmin = await loginAs(harness.app, "admin");
    const list = await harness.app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: namedAdmin.cookie },
    });
    assert.equal(list.statusCode, 403);
  } finally {
    await harness.close();
  }
});
