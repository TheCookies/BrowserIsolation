/**
 * Real Docker integration test. Skipped unless RBI_INTEGRATION=1.
 *
 * Requires: Docker engine, ability to pull/run the pinned Neko image,
 * and the host port range free (or WEBRTC_PORT_RANGE set to a free range).
 */
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
import { createDockerRuntime } from "../src/docker/container-runtime";
import { createNekoClient } from "../src/neko-client";
import { testPlacement } from "./helpers";

const enabled = process.env.RBI_INTEGRATION === "1";

function integrationConfig(dir: string): Config {
  const range = process.env.WEBRTC_PORT_RANGE?.trim() || "52100-52109";
  const [startRaw, endRaw] = range.split("-");
  return {
    host: "127.0.0.1",
    port: 0,
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
    nekoImageTag: process.env.NEKO_IMAGE_TAG?.trim() || "3.1.6",
    browserNetwork: process.env.BROWSER_NETWORK?.trim() || "rbi-browsers-it",
    browserShmSizeBytes: 2 * 1024 ** 3,
    browserNanoCpus: 1e9,
    browserMemoryBytes: 2 * 1024 ** 3,
    publicIp: process.env.PUBLIC_IP?.trim() || "127.0.0.1",
    webrtcPortStart: Number(startRaw),
    webrtcPortEnd: Number(endRaw),
    webrtcIceLite: true,
    iceServersFrontend: "[]",
    iceServersBackend: "[]",
    desktopScreen: "1280x720@30",
    captureVideoCodec: "vp8",
    dockerSocketPath: process.env.DOCKER_SOCKET?.trim() || "/var/run/docker.sock",
    nekoPoliciesDir: path.resolve(__dirname, "../neko-policies"),
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

test(
  "integration: launch, reconnect, and destroy a real Neko container",
  { skip: enabled ? false : "set RBI_INTEGRATION=1 to run Docker integration tests" },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rbi-it-"));
    const config = integrationConfig(dir);
    const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
    const store = createBrowserSessionStore(db);
    const runtime = createDockerRuntime(config);
    const { placement } = testPlacement(db, config, runtime);
    const service = createBrowserSessionService({
      config,
      store,
      placement,
      neko: createNekoClient(),
      preferences,
    });

    const username = `it-${Date.now().toString(36)}`;
    const user = { username, role: "user" as const, subjectId: `local:${username}` };

    try {
      await runtime.ensureNetwork();
      const first = await service.launch(user, "google-chrome");
      assert.equal(first.reconnect, false);
      assert.ok(first.session.containerId);

      const info = await placement.inspect(first.session.workerId, first.session.containerId);
      assert.ok(info?.running);

      const second = await service.launch(user, "firefox");
      assert.equal(second.reconnect, true);
      assert.equal(second.session.id, first.session.id);
      assert.equal(second.session.browser, "google-chrome");

      const destroyed = await service.destroyForUser(user.username);
      assert.equal(destroyed, true);
      assert.equal(store.getByOwner(user.username), null);

      const after = await placement.inspect(first.session.workerId, first.session.containerId);
      assert.equal(after, null);
    } finally {
      await service.destroyForUser(user.username).catch(() => undefined);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
