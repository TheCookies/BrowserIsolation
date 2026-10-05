import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { defaultAuditEnabledActions } from "../src/audit-store";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import type { BrowserContainerInfo, ContainerRuntime } from "../src/docker/container-runtime";
import { LABEL_MANAGED, LABEL_SESSION, managedLabels } from "../src/docker/labels";
import { reconcileBrowserSessions, reapBrowserSessions } from "../src/lifecycle";
import { createViewerTracker } from "../src/viewer-tracker";
import { sampleSession, testPlacement } from "./helpers";

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
    iceServersFrontend: "[]",
    iceServersBackend: "[]",
    desktopScreen: "1920x1080@30",
    captureVideoCodec: "vp8",
    dockerSocketPath: "/var/run/docker.sock",
    nekoPoliciesDir: "/tmp/neko-policies-unused",
    persistProfilesEnabled: true,
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
    auditEnabledActions: defaultAuditEnabledActions(),
    idleTimeoutMinutes: 60,
    maxSessionHours: 12,
    reaperIntervalSeconds: 60,
  };
}

function fakeRuntime(containers: Map<string, BrowserContainerInfo>): ContainerRuntime {
  return {
    async ensureNetwork() {},
    async createBrowserContainer() {
      throw new Error("unused");
    },
    async inspect(containerId) {
      return containers.get(containerId) ?? null;
    },
    async stats() {
      return { cpuPercent: null, memoryBytes: null };
    },
    async logs() {
      return "";
    },
    async remove(containerId) {
      containers.delete(containerId);
    },
    async listManaged() {
      return [...containers.values()].filter((item) => item.labels[LABEL_MANAGED] === "true");
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
}

test("reaper destroys idle sessions with no viewers and respects active viewers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-reaper-"));
  const config = testConfig(dir);
  config.idleTimeoutMinutes = 30;
  const db = openDatabase(config.databasePath);
  const store = createBrowserSessionStore(db);
  const viewers = createViewerTracker();
  const containers = new Map<string, BrowserContainerInfo>();
  const { placement } = testPlacement(db, config, fakeRuntime(containers));
  const now = Date.now();

  const idle = sampleSession({
    id: "idle-session",
    ownerUsername: "gus",
    containerId: "cid-idle",
    containerName: "rbi-idle",
    webrtcPort: 52001,
    createdAt: now - 60 * 60_000,
    lastActivityAt: now - 45 * 60_000,
  });
  const active = sampleSession({
    id: "active-session",
    ownerUsername: "ada",
    containerId: "cid-active",
    containerName: "rbi-active",
    webrtcPort: 52002,
    createdAt: now - 60 * 60_000,
    lastActivityAt: now - 45 * 60_000,
  });
  store.insert(idle);
  store.insert(active);
  containers.set(idle.containerId, {
    id: idle.containerId,
    name: idle.containerName,
    ipAddress: "10.0.0.2",
    running: true,
    status: "running",
    labels: managedLabels({ owner: "gus", sessionId: idle.id, browser: "google-chrome" }),
  });
  containers.set(active.containerId, {
    id: active.containerId,
    name: active.containerName,
    ipAddress: "10.0.0.3",
    running: true,
    status: "running",
    labels: managedLabels({ owner: "ada", sessionId: active.id, browser: "google-chrome" }),
  });
  viewers.join(active.id);

  const summary = await reapBrowserSessions({ config, store, placement, viewers }, now);

  assert.equal(summary.destroyedIdle, 1);
  assert.equal(summary.destroyedExpired, 0);
  assert.equal(store.getById(idle.id), null);
  assert.ok(store.getById(active.id));
  assert.equal(containers.has(idle.containerId), false);
  assert.equal(containers.has(active.containerId), true);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reaper destroys sessions past MAX_SESSION_HOURS even with viewers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-maxlife-"));
  const config = testConfig(dir);
  config.maxSessionHours = 1;
  const db = openDatabase(config.databasePath);
  const store = createBrowserSessionStore(db);
  const viewers = createViewerTracker();
  const containers = new Map<string, BrowserContainerInfo>();
  const { placement } = testPlacement(db, config, fakeRuntime(containers));
  const now = Date.now();

  const expired = sampleSession({
    id: "expired-session",
    containerId: "cid-expired",
    webrtcPort: 52003,
    createdAt: now - 2 * 60 * 60_000,
    lastActivityAt: now,
  });
  store.insert(expired);
  containers.set(expired.containerId, {
    id: expired.containerId,
    name: expired.containerName,
    ipAddress: "10.0.0.4",
    running: true,
    status: "running",
    labels: managedLabels({ owner: "gus", sessionId: expired.id, browser: "firefox" }),
  });
  viewers.join(expired.id);

  const summary = await reapBrowserSessions({ config, store, placement, viewers }, now);

  assert.equal(summary.destroyedExpired, 1);
  assert.equal(store.getById(expired.id), null);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reconcile adopts running containers and removes orphans and stale rows", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-reconcile-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const store = createBrowserSessionStore(db);
  const viewers = createViewerTracker();
  const containers = new Map<string, BrowserContainerInfo>();
  const { placement } = testPlacement(db, config, fakeRuntime(containers));

  const adopt = sampleSession({
    id: "adopt-me",
    containerId: "old-id",
    containerName: "rbi-old",
    webrtcPort: 52010,
  });
  store.insert(adopt);
  containers.set("new-id", {
    id: "new-id",
    name: "rbi-new",
    ipAddress: "10.0.0.5",
    running: true,
    status: "running",
    labels: {
      ...managedLabels({ owner: "gus", sessionId: adopt.id, browser: "google-chrome" }),
    },
  });

  const stale = sampleSession({
    id: "stale-me",
    ownerUsername: "ada",
    containerId: "missing",
    containerName: "rbi-stale",
    webrtcPort: 52011,
  });
  store.insert(stale);

  containers.set("orphan-id", {
    id: "orphan-id",
    name: "rbi-orphan",
    ipAddress: "10.0.0.6",
    running: true,
    status: "running",
    labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_SESSION]: "no-such-session",
    },
  });

  const summary = await reconcileBrowserSessions({ config, store, placement, viewers });

  assert.equal(summary.adopted, 1);
  assert.equal(summary.removedStaleSessions, 1);
  assert.equal(summary.removedOrphanContainers, 1);
  assert.equal(store.getById(adopt.id)?.containerId, "new-id");
  assert.equal(store.getById(stale.id), null);
  assert.equal(containers.has("orphan-id"), false);
  assert.equal(containers.has("new-id"), true);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
