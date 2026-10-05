import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app";
import type { AuthProvider } from "../src/auth/provider";
import { localSubjectId, profileStorageKey, profileVolumeName } from "../src/auth/identity";
import { defaultAuditEnabledActions } from "../src/audit-store";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { createBrowserSessionService } from "../src/browser-sessions";
import type { ContainerRuntime } from "../src/docker/container-runtime";
import type { NekoClient } from "../src/neko-client";
import { createSessionStore } from "../src/session-store";
import { createUserPreferencesStore } from "../src/user-preferences";
import { stubRuntime, testPlacement, testSideChannels } from "./helpers";

const auth: AuthProvider = {
  async authenticate(username, password) {
    if (password !== "secret") return null;
    if (username === "ada") return { username: "ada", role: "admin", subjectId: "local:ada" };
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

test("admin profile-volumes maps Docker volumes to usernames and sizes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-vol-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const store = createBrowserSessionStore(db);
  const side = testSideChannels(db, config);

  const subjectId = localSubjectId("alice");
  await side.localUsers.create(
    { username: "alice", password: "secret", role: "user" },
    config.bcryptRounds,
  );
  preferences.setPersistProfile(subjectId, true);

  const volumeName = profileVolumeName(subjectId, "google-chrome");
  const runtime: ContainerRuntime = stubRuntime({
    async listProfileVolumes() {
      return [
        {
          name: volumeName,
          subjectKey: profileStorageKey(subjectId),
          browser: "google-chrome",
          sizeBytes: 42_000_000,
          createdAt: "2026-01-02T03:04:05Z",
          mountpoint: `/var/lib/docker/volumes/${volumeName}/_data`,
        },
      ];
    },
  });

  const neko: NekoClient = {
    async waitUntilReady() {},
    async login() {
      return { token: "neko-token" };
    },
  };
  const { placement, workerStore } = testPlacement(db, config, runtime);
  const browsers = createBrowserSessionService({ config, store, placement, neko, preferences });

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

  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      cookie: cookiePair(csrf, "rbi_csrf"),
      "x-csrf-token": (csrf.json() as { csrfToken: string }).csrfToken,
    },
    payload: { username: "ada", password: "secret" },
  });
  assert.equal(login.statusCode, 200);

  const response = await app.inject({
    method: "GET",
    url: "/api/admin/profile-volumes",
    headers: { cookie: cookiePair(login, "rbi_session") },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    volumes: Array<{
      username: string | null;
      browser: string | null;
      sizeBytes: number | null;
      persistProfileEnabled: boolean | null;
      workerId: string;
    }>;
    totalBytes: number;
  };
  assert.equal(body.volumes.length, 1);
  assert.equal(body.volumes[0]?.username, "alice");
  assert.equal(body.volumes[0]?.browser, "google-chrome");
  assert.equal(body.volumes[0]?.sizeBytes, 42_000_000);
  assert.equal(body.volumes[0]?.persistProfileEnabled, true);
  assert.equal(body.volumes[0]?.workerId, "local");
  assert.equal(body.totalBytes, 42_000_000);

  let removed: string | null = null;
  const runtimeWithDelete: ContainerRuntime = stubRuntime({
    async listProfileVolumes() {
      return removed
        ? []
        : [
            {
              name: volumeName,
              subjectKey: profileStorageKey(subjectId),
              browser: "google-chrome",
              sizeBytes: 42_000_000,
              createdAt: "2026-01-02T03:04:05Z",
              mountpoint: `/var/lib/docker/volumes/${volumeName}/_data`,
            },
          ];
    },
    async removeProfileVolume(name) {
      removed = name;
    },
  });

  // Rebuild app deps with deleteable runtime via direct call on same app is hard;
  // exercise delete on a fresh inject after swapping is not available — call route via second harness piece:
  await app.close();

  const { placement: placement2, workerStore: workerStore2 } = testPlacement(
    db,
    config,
    runtimeWithDelete,
  );
  const app2 = await buildApp({
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
    runtime: runtimeWithDelete,
    placement: placement2,
    workerStore: workerStore2,
    logger: false,
  });

  const csrf2 = await app2.inject({ method: "GET", url: "/api/auth/csrf" });
  const login2 = await app2.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      cookie: cookiePair(csrf2, "rbi_csrf"),
      "x-csrf-token": (csrf2.json() as { csrfToken: string }).csrfToken,
    },
    payload: { username: "ada", password: "secret" },
  });
  const del = await app2.inject({
    method: "DELETE",
    url: "/api/admin/profile-volumes",
    headers: {
      cookie: cookiePair(login2, "rbi_session"),
      "x-csrf-token": (login2.json() as { csrfToken: string }).csrfToken,
      "content-type": "application/json",
    },
    payload: { workerId: "local", volumeName },
  });
  assert.equal(del.statusCode, 200);
  assert.equal(removed, volumeName);

  await app2.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
