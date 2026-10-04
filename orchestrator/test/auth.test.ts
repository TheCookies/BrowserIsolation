import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createSessionStore } from "../src/session-store";
import { stubBrowsers, testSideChannels } from "./helpers";

/**
 * Names are intentionally not the source of authorization.
 * The account named "admin" is a normal user. "ada" is an administrator.
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

function testConfig(dir: string, options?: { cookieSecure?: boolean; staticDir?: string | null }): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    trustProxy: false,
    cookieSecure: options?.cookieSecure ?? false,
    cookieName: "rbi_session",
    csrfCookieName: "rbi_csrf",
    sessionTtlMs: 60 * 60 * 1000,
    databasePath: path.join(dir, "rbi.sqlite"),
    staticDir: options?.staticDir ?? null,
    authUsers: "unused-by-injected-provider",
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

async function build(options?: { cookieSecure?: boolean; staticDir?: string | null }) {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-auth-"));
  const config = testConfig(dir, options);
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const app = await buildApp({
    config,
    auth,
    sessions,
    browsers: stubBrowsers(),
    ...testSideChannels(db, config),
    preferences,
    logger: false,
  });
  return {
    app,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function issueCsrf(app: Awaited<ReturnType<typeof build>>["app"]) {
  const response = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { csrfToken: string };
  return { token: body.csrfToken, cookie: cookiePair(response, "rbi_csrf"), response };
}

test("login sets an HttpOnly SameSite cookie and /api/me returns the role", async () => {
  const ctx = await build();
  try {
    const csrf = await issueCsrf(ctx.app);
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { cookie: csrf.cookie, "x-csrf-token": csrf.token },
      payload: { username: "gus", password: "secret" },
    });
    assert.equal(login.statusCode, 200);
    const sessionCookie = login.cookies.find((item) => item.name === "rbi_session");
    assert.ok(sessionCookie);
    assert.equal(sessionCookie.httpOnly, true);
    assert.equal(String(sessionCookie.sameSite).toLowerCase(), "lax");
    assert.notEqual(sessionCookie.secure, true);
    assert.equal(sessionCookie.path, "/");

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookiePair(login, "rbi_session") },
    });
    assert.equal(me.statusCode, 200);
    const body = me.json() as { username: string; role: string; csrfToken: string };
    assert.equal(body.username, "gus");
    assert.equal(body.role, "user");
    assert.equal(typeof body.csrfToken, "string");
  } finally {
    await ctx.close();
  }
});

test("Secure is set on the session cookie when configured", async () => {
  const ctx = await build({ cookieSecure: true });
  try {
    const csrf = await issueCsrf(ctx.app);
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { cookie: csrf.cookie, "x-csrf-token": csrf.token },
      payload: { username: "gus", password: "secret" },
    });
    const sessionCookie = login.cookies.find((item) => item.name === "rbi_session");
    assert.equal(sessionCookie?.secure, true);
  } finally {
    await ctx.close();
  }
});

test("mutating routes reject a missing or mismatched CSRF token before authentication", async () => {
  let calls = 0;
  const counting: AuthProvider = {
    async authenticate(username, password) {
      calls += 1;
      return auth.authenticate(username, password);
    },
  };
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-csrf-"));
  const config = testConfig(dir);
  config.sessionTtlMs = 60_000;
  config.authUsers = "unused";
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const app = await buildApp({
    config,
    auth: counting,
    sessions: createSessionStore(db, config.sessionTtlMs),
    browsers: stubBrowsers(),
    ...testSideChannels(db, config),
    preferences,
    logger: false,
  });
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "gus", password: "secret" },
    });
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json().error, "csrf_failed");
    assert.equal(calls, 0);

    const csrf = await issueCsrf(app);
    const mismatched = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { cookie: csrf.cookie, "x-csrf-token": "not-the-token" },
      payload: { username: "gus", password: "secret" },
    });
    assert.equal(mismatched.statusCode, 403);
    assert.equal(calls, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bad credentials stay generic and do not create a session", async () => {
  const ctx = await build();
  try {
    const csrf = await issueCsrf(ctx.app);
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { cookie: csrf.cookie, "x-csrf-token": csrf.token },
      payload: { username: "gus", password: "wrong" },
    });
    assert.equal(login.statusCode, 401);
    assert.equal(login.json().error, "invalid_credentials");
    assert.equal(
      login.cookies.some((item) => item.name === "rbi_session"),
      false,
    );
  } finally {
    await ctx.close();
  }
});

test("authorization uses the role, so a user named admin cannot open the admin API", async () => {
  const ctx = await build();
  try {
    const adminNamedUser = await loginAs(ctx.app, "admin");
    const denied = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: adminNamedUser.cookie },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, "forbidden");

    const ada = await loginAs(ctx.app, "ada");
    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/sessions",
      headers: { cookie: ada.cookie },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), { sessions: [] });

    const anonymous = await ctx.app.inject({ method: "GET", url: "/api/admin/sessions" });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test("logout requires the session CSRF token and then ends the session", async () => {
  const ctx = await build();
  try {
    const loggedIn = await loginAs(ctx.app, "ada");
    const noToken = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: loggedIn.cookie },
    });
    assert.equal(noToken.statusCode, 403);

    const stillIn = await ctx.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: loggedIn.cookie },
    });
    assert.equal(stillIn.statusCode, 200);

    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: loggedIn.cookie, "x-csrf-token": loggedIn.csrfToken },
    });
    assert.equal(logout.statusCode, 200);

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: loggedIn.cookie },
    });
    assert.equal(after.statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test("the portal shell is served for pages and the API stays JSON", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-static-"));
  const staticDir = path.join(dir, "static");
  mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>portal</title>");
  writeFileSync(path.join(staticDir, "assets", "app.js"), "console.log(1)");
  const ctx = await build({ staticDir });
  try {
    const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true });

    const home = await ctx.app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /portal/);

    const login = await ctx.app.inject({ method: "GET", url: "/login" });
    assert.equal(login.statusCode, 200);
    assert.match(login.body, /portal/);

    const asset = await ctx.app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /console.log/);

    const favicon = await ctx.app.inject({ method: "GET", url: "/favicon.ico" });
    assert.equal(favicon.statusCode, 404);
    assert.equal(favicon.json().error, "not_found");

    const missingApi = await ctx.app.inject({ method: "GET", url: "/api/missing" });
    assert.equal(missingApi.statusCode, 404);
    assert.equal(missingApi.json().error, "not_found");
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function loginAs(app: Awaited<ReturnType<typeof build>>["app"], username: string) {
  const csrf = await issueCsrf(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { cookie: csrf.cookie, "x-csrf-token": csrf.token },
    payload: { username, password: "secret" },
  });
  assert.equal(login.statusCode, 200);
  const body = login.json() as { csrfToken: string; role: string };
  return { cookie: cookiePair(login, "rbi_session"), csrfToken: body.csrfToken, role: body.role };
}
