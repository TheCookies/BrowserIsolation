import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { createBrowserSessionService } from "../src/browser-sessions";
import { defaultAuditEnabledActions } from "../src/audit-store";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { createUserPreferencesStore } from "../src/user-preferences";
import type { BrowserContainerInfo, ContainerRuntime } from "../src/docker/container-runtime";
import type { NekoClient } from "../src/neko-client";
import { testPlacement } from "./helpers";

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
    nekoImageTag: "test",
    browserNetwork: "rbi-browsers",
    browserNetworkMode: "bridge" as const,
    browserShmSizeBytes: 2 * 1024 ** 3,
    browserNanoCpus: 1e9,
    browserMemoryBytes: 2 * 1024 ** 3,
    publicIp: "127.0.0.1",
    webrtcPortStart: 52000,
    webrtcPortEnd: 52001,
    webrtcIceLite: true,
    desktopScreen: "1920x1080@30",
    captureVideoCodec: "vp8" as const,
    iceServersFrontend: "[]",
    iceServersBackend: "[]",
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
    auditEnabledActions: defaultAuditEnabledActions(),
    idleTimeoutMinutes: 60,
    maxSessionHours: 12,
    reaperIntervalSeconds: 60,
  };
}

function makeRuntime(
  containers: Map<string, BrowserContainerInfo>,
  hooks?: { created?: string[]; removed?: string[]; onInspect?: () => void },
): ContainerRuntime {
  return {
    async ensureNetwork() {},
    async createBrowserContainer(input) {
      hooks?.created?.push(input.sessionId);
      const info: BrowserContainerInfo = {
        id: `cid-${hooks?.created?.length ?? containers.size + 1}`,
        name: `rbi-${input.sessionId.slice(0, 12)}`,
        ipAddress: "10.0.0.2",
        running: true,
        status: "running",
        labels: {},
      };
      containers.set(info.id, info);
      return info;
    },
    async inspect(containerId) {
      hooks?.onInspect?.();
      return containers.get(containerId) ?? null;
    },
    async stats() {
      return { cpuPercent: 2, memoryBytes: 32 * 1024 * 1024 };
    },
    async logs() {
      return "";
    },
    async remove(containerId) {
      hooks?.removed?.push(containerId);
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
}

const neko: NekoClient = {
  async waitUntilReady() {},
  async login() {
    return { token: "t" };
  },
};

test("launch reconnects to the existing container for the same user", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-life-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const created: string[] = [];
  const removed: string[] = [];
  const containers = new Map<string, BrowserContainerInfo>();
  const runtime = makeRuntime(containers, { created, removed });
  const { placement } = testPlacement(db, config, runtime);

  const service = createBrowserSessionService({ config, store, placement, neko, preferences });
  const user = { username: "gus", role: "user" as const, subjectId: "local:gus" };

  const first = await service.launch(user, "google-chrome");
  assert.equal(first.reconnect, false);
  assert.equal(created.length, 1);
  assert.equal(first.session.workerId, "local");

  const second = await service.launch(user, "firefox");
  assert.equal(second.reconnect, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.browser, "google-chrome");
  assert.equal(created.length, 1);

  const destroyed = await service.destroyForUser(user);
  assert.equal(destroyed, true);
  assert.deepEqual(removed, [first.session.containerId]);
  assert.equal(store.getByOwner("gus"), null);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("launch reconnects LDAP users by subjectId even when display username changes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-ldap-session-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const created: string[] = [];
  const removed: string[] = [];
  const containers = new Map<string, BrowserContainerInfo>();
  const runtime = makeRuntime(containers, { created, removed });
  const { placement } = testPlacement(db, config, runtime);
  const service = createBrowserSessionService({ config, store, placement, neko, preferences });

  const firstUser = {
    username: "alice",
    role: "user" as const,
    subjectId: "ldap:01020304-0506-0708-090a-0b0c0d0e0f10",
  };
  const first = await service.launch(firstUser, "firefox");
  assert.equal(first.reconnect, false);
  assert.equal(first.session.ownerSubjectId, firstUser.subjectId);

  // Same directory person, different typed login / display form.
  const secondUser = {
    username: "alice@corp.example.com",
    role: "user" as const,
    subjectId: firstUser.subjectId,
  };
  const second = await service.launch(secondUser, "firefox");
  assert.equal(second.reconnect, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(created.length, 1);
  assert.equal(removed.length, 0);

  await service.destroyForUser(secondUser);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("launch abandons a session on a disabled worker and uses an available one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-worker-failover-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const created: string[] = [];
  const removed: string[] = [];
  const containers = new Map<string, BrowserContainerInfo>();
  const runtime = makeRuntime(containers, { created, removed });
  const { placement, workerStore } = testPlacement(db, config, runtime);

  workerStore.upsert({
    id: "worker1",
    baseUrl: "http://worker1:8090",
    publicIp: "10.0.0.10",
    token: "secret",
    enabled: false,
    kind: "remote",
    lastSeenAt: Date.now(),
    activeSessions: 1,
  });

  const now = Date.now();
  store.insert({
    id: "stale-session",
    ownerUsername: "gus",
    ownerSubjectId: "local:gus",
    browser: "google-chrome",
    containerId: "gone-container",
    containerName: "rbi-gone",
    nekoAdminPassword: "a",
    nekoUserPassword: "u",
    webrtcPort: 52000,
    workerId: "worker1",
    createdAt: now,
    lastActivityAt: now,
  });

  const service = createBrowserSessionService({ config, store, placement, neko, preferences });
  const result = await service.launch(
    { username: "gus", role: "user", subjectId: "local:gus" },
    "google-chrome",
  );

  assert.equal(result.reconnect, false);
  assert.equal(result.session.workerId, "local");
  assert.equal(store.getById("stale-session"), null);
  assert.equal(created.length, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("launch still succeeds when cleaning up a dead worker fails with unauthorized", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-worker-unauth-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const created: string[] = [];
  const containers = new Map<string, BrowserContainerInfo>();
  const runtime = makeRuntime(containers, { created });
  const { placement, workerStore } = testPlacement(db, config, runtime);

  // Session points at local, but inspect will fail because container is missing and
  // remove will throw — launch must still create a fresh session.
  const now = Date.now();
  store.insert({
    id: "broken-session",
    ownerUsername: "gus",
    ownerSubjectId: "local:gus",
    browser: "firefox",
    containerId: "missing-cid",
    containerName: "rbi-missing",
    nekoAdminPassword: "a",
    nekoUserPassword: "u",
    webrtcPort: 52000,
    workerId: "local",
    createdAt: now,
    lastActivityAt: now,
  });

  const originalRemove = runtime.remove.bind(runtime);
  runtime.remove = async (containerId) => {
    if (containerId === "missing-cid") {
      throw new Error("unauthorized");
    }
    return originalRemove(containerId);
  };

  workerStore.touchStatus("local", {
    lastSeenAt: Date.now(),
    activeSessions: 1,
    publicIp: config.publicIp,
  });

  const service = createBrowserSessionService({ config, store, placement, neko, preferences });
  const result = await service.launch(
    { username: "gus", role: "user", subjectId: "local:gus" },
    "firefox",
  );

  assert.equal(result.reconnect, false);
  assert.equal(store.getById("broken-session"), null);
  assert.equal(result.session.browser, "firefox");
  assert.equal(created.length, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("assertAccess allows owners and admins only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-acl-unit-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const containers = new Map<string, BrowserContainerInfo>();
  const runtime = makeRuntime(containers);
  const { placement } = testPlacement(db, config, runtime);

  const service = createBrowserSessionService({
    config,
    store,
    placement,
    neko,
    preferences,
  });

  const launched = await service.launch({ username: "gus", role: "user", subjectId: "local:gus" }, "firefox");

  assert.throws(
    () => service.assertAccess({ username: "admin", role: "user", subjectId: "local:admin" }, launched.session.id),
    (error: Error & { statusCode?: number }) => error.statusCode === 403,
  );

  const asAdmin = service.assertAccess({ username: "ada", role: "admin", subjectId: "local:ada" }, launched.session.id);
  assert.equal(asAdmin.id, launched.session.id);

  const asOwner = service.assertAccess({ username: "gus", role: "user", subjectId: "local:gus" }, launched.session.id);
  assert.equal(asOwner.id, launched.session.id);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("resolveProxyTarget caches docker inspect results briefly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-proxy-cache-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const containers = new Map<string, BrowserContainerInfo>();
  let inspectCalls = 0;
  const runtime = makeRuntime(containers, { onInspect: () => { inspectCalls += 1; } });
  const { placement } = testPlacement(db, config, runtime);

  const service = createBrowserSessionService({
    config,
    store,
    placement,
    neko,
    preferences,
  });

  const launched = await service.launch({ username: "gus", role: "user", subjectId: "local:gus" }, "google-chrome");
  const baseline = inspectCalls;

  const first = await service.resolveProxyTarget(launched.session.id);
  const afterFirst = inspectCalls;
  assert.equal(first.proxy.targetOrigin, `http://${launched.session.containerName}:8080`);
  assert.ok(afterFirst > baseline);

  const second = await service.resolveProxyTarget(launched.session.id);
  assert.equal(second.proxy.targetOrigin, first.proxy.targetOrigin);
  assert.equal(inspectCalls, afterFirst, "second resolve should use cache");

  await service.destroyForUser({ username: "gus", subjectId: "local:gus" });
  await assert.rejects(
    () => service.resolveProxyTarget(launched.session.id),
    (error: Error & { statusCode?: number }) => error.statusCode === 404,
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent LDAP users each get a browser and a distinct WebRTC port", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-ldap-parallel-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const store = createBrowserSessionStore(db);
  const containers = new Map<string, BrowserContainerInfo>();
  const runtime = makeRuntime(containers);
  const portsInUse = new Map<string, number>();
  const originalCreate = runtime.createBrowserContainer.bind(runtime);
  runtime.createBrowserContainer = async (input) => {
    // Hold the create open so the second launch allocates before the first row exists.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if ([...portsInUse.values()].includes(input.webrtcPort)) {
      throw new Error("port is already allocated");
    }
    const info = await originalCreate(input);
    portsInUse.set(info.id, input.webrtcPort);
    return info;
  };
  const originalRemove = runtime.remove.bind(runtime);
  runtime.remove = async (containerId) => {
    portsInUse.delete(containerId);
    return originalRemove(containerId);
  };

  const { placement } = testPlacement(db, config, runtime);
  const service = createBrowserSessionService({ config, store, placement, neko, preferences });
  const alice = { username: "alice", role: "user" as const, subjectId: "ldap:guid-alice" };
  const bob = { username: "bob", role: "user" as const, subjectId: "ldap:guid-bob" };

  const [first, second] = await Promise.all([
    service.launch(alice, "firefox"),
    service.launch(bob, "firefox"),
  ]);

  assert.equal(first.reconnect, false);
  assert.equal(second.reconnect, false);
  assert.notEqual(first.session.id, second.session.id);
  assert.notEqual(first.session.ownerSubjectId, second.session.ownerSubjectId);
  assert.notEqual(first.session.webrtcPort, second.session.webrtcPort);
  assert.equal(store.list().length, 2);

  await service.destroyForUser(alice);
  await service.destroyForUser(bob);
  const cara = { username: "cara", role: "user" as const, subjectId: "ldap:guid-cara" };
  const third = await service.launch(cara, "firefox");
  assert.equal(third.reconnect, false);
  assert.equal(store.list().length, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
