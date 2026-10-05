import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { LightMyRequestResponse } from "fastify";
import type { AuthProvider } from "../src/auth/provider";
import { buildApp } from "../src/app";
import { defaultAuditEnabledActions } from "../src/audit-store";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { createUserPreferencesStore } from "../src/user-preferences";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { createBrowserSessionService } from "../src/browser-sessions";
import type { ContainerRuntime, BrowserContainerInfo } from "../src/docker/container-runtime";
import type { NekoClient } from "../src/neko-client";
import { createSessionStore } from "../src/session-store";
import { sampleSession, testPlacement, testSideChannels } from "./helpers";

/**
 * Names are intentionally not the source of authorization.
 * "admin" is a normal user. "ada" is an administrator.
 */
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

function startFakeNeko(): Promise<{
  origin: string;
  hits: { method: string; url: string }[];
  close: () => Promise<void>;
}> {
  const hits: { method: string; url: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? "GET", url: req.url ?? "/" });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("neko-ok");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    hits.push({ method: "UPGRADE", url: req.url ?? "/" });
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Delay so clients can subscribe to "message" after "open".
      setTimeout(() => {
        ws.send("neko-ws");
        ws.close();
      }, 20);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        hits,
        async close() {
          await new Promise<void>((res, rej) => wss.close((err) => (err ? rej(err) : res())));
          await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
        },
      });
    });
  });
}

/** Perform a WebSocket upgrade and return the raw HTTP status line code. */
function upgradeStatus(port: number, urlPath: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `GET ${urlPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Cookie: ${cookie}\r\n` +
          `\r\n`,
      );
    });
    let settled = false;
    const finish = (error: Error | null, status?: number) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(status!);
    };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const endHeaders = buffer.indexOf("\r\n\r\n");
      if (endHeaders === -1) return;
      const status = Number(buffer.slice(0, endHeaders).split("\r\n")[0]?.split(" ")[1]);
      if (!Number.isInteger(status)) {
        finish(new Error(`bad upgrade response: ${buffer.slice(0, 80)}`));
        return;
      }
      finish(null, status);
    });
    socket.on("error", (error) => finish(error));
    socket.setTimeout(5000, () => finish(new Error("upgrade timeout")));
  });
}

async function buildHarness(fakeOrigin: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-acl-"));
  const config = testConfig(dir);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const store = createBrowserSessionStore(db);
  const containers = new Map<string, BrowserContainerInfo>();

  const runtime: ContainerRuntime = {
    async ensureNetwork() {},
    async createBrowserContainer(input) {
      const info: BrowserContainerInfo = {
        id: `cid-${input.sessionId.slice(0, 8)}`,
        name: `rbi-${input.sessionId.slice(0, 12)}`,
        ipAddress: "127.0.0.1",
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
      return { cpuPercent: 1.5, memoryBytes: 64 * 1024 * 1024 };
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
  const inner = createBrowserSessionService({ config, store, placement, neko, preferences });
  const browsers = {
    ...inner,
    async resolveProxyTarget(sessionId: string) {
      const session = store.getById(sessionId);
      if (!session) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      store.touch(session.id);
      return { session, proxy: { targetOrigin: fakeOrigin } };
    },
  };

  const ownerSession = sampleSession({
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerUsername: "gus",
    containerId: "cid-owner",
    webrtcPort: 52001,
  });
  containers.set(ownerSession.containerId, {
    id: ownerSession.containerId,
    name: ownerSession.containerName,
    ipAddress: "127.0.0.1",
    running: true,
    status: "running",
    labels: {},
  });
  store.insert(ownerSession);

  const side = testSideChannels(db, config);
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
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");

  return {
    app,
    ownerSession,
    audit: side.audit,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("user receives 403 HTTP when requesting another user's session proxy URL", async () => {
  const fake = await startFakeNeko();
  const harness = await buildHarness(fake.origin);
  try {
    const otherUser = await loginAs(harness.app, "admin");
    const denied = await fetch(`${harness.origin}/session/${harness.ownerSession.id}/view/`, {
      headers: { cookie: otherUser.cookie },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "forbidden" });
    assert.equal(fake.hits.length, 0);

    const owner = await loginAs(harness.app, "gus");
    const allowed = await fetch(`${harness.origin}/session/${harness.ownerSession.id}/view/`, {
      headers: { cookie: owner.cookie },
    });
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "neko-ok");
    assert.ok(fake.hits.some((hit) => hit.method === "GET"));

    const admin = await loginAs(harness.app, "ada");
    const asAdmin = await fetch(`${harness.origin}/session/${harness.ownerSession.id}/view/`, {
      headers: { cookie: admin.cookie },
    });
    assert.equal(asAdmin.status, 200);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test("user receives 403 on WebSocket upgrade to another user's session", async () => {
  const fake = await startFakeNeko();
  const harness = await buildHarness(fake.origin);
  try {
    const otherUser = await loginAs(harness.app, "admin");
    const deniedStatus = await upgradeStatus(
      harness.port,
      `/session/${harness.ownerSession.id}/view/ws`,
      otherUser.cookie,
    );
    assert.equal(deniedStatus, 403);
    assert.equal(
      fake.hits.filter((hit) => hit.method === "UPGRADE").length,
      0,
    );

    const owner = await loginAs(harness.app, "gus");
    const allowed = new WebSocket(
      `ws://127.0.0.1:${harness.port}/session/${harness.ownerSession.id}/view/ws`,
      { headers: { cookie: owner.cookie } },
    );
    const messagePromise = once(allowed, "message") as Promise<[WebSocket.RawData]>;
    await once(allowed, "open");
    const [message] = await messagePromise;
    assert.equal(String(message), "neko-ws");
    allowed.close();
    const upgrade = fake.hits.find((hit) => hit.method === "UPGRADE");
    assert.ok(upgrade);
    assert.equal(upgrade.url, "/ws");
  } finally {
    await harness.close();
    await fake.close();
  }
});
