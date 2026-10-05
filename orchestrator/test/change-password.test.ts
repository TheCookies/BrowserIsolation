import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app";
import { createLocalAuthProvider } from "../src/auth/local-provider";
import { openDatabase } from "../src/db";
import { createUserPreferencesStore } from "../src/user-preferences";
import { createSessionStore } from "../src/session-store";
import { stubBrowsers, testConfig, testSideChannels } from "./helpers";

function cookiePair(response: LightMyRequestResponse, name: string): string {
  const cookie = response.cookies.find((item) => item.name === name);
  assert.ok(cookie, `missing cookie ${name}`);
  return `${name}=${cookie.value}`;
}

async function buildLocal() {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-change-password-"));
  const config = testConfig({ databasePath: path.join(dir, "rbi.sqlite") });
  const db = openDatabase(config.databasePath);
  const preferences = createUserPreferencesStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const side = testSideChannels(db, config);
  const localUsers = side.localUsers;
  await localUsers.create({ username: "gus", password: "secret", role: "user" }, config.bcryptRounds);
  const auth = await createLocalAuthProvider(localUsers, config.bcryptRounds);
  const app = await buildApp({
    config,
    auth,
    sessions,
    browsers: stubBrowsers(),
    ...side,
    localUsers,
    preferences,
    logger: false,
  });
  return {
    app,
    localUsers,
    sessions,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function loginAs(app: Awaited<ReturnType<typeof buildLocal>>["app"], username: string, password: string) {
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf" });
  assert.equal(csrf.statusCode, 200);
  const csrfBody = csrf.json() as { csrfToken: string };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { cookie: cookiePair(csrf, "rbi_csrf"), "x-csrf-token": csrfBody.csrfToken },
    payload: { username, password },
  });
  assert.equal(login.statusCode, 200);
  const body = login.json() as {
    csrfToken: string;
    canChangePassword: boolean;
    subjectId: string;
  };
  return {
    cookie: cookiePair(login, "rbi_session"),
    csrfToken: body.csrfToken,
    canChangePassword: body.canChangePassword,
    subjectId: body.subjectId,
  };
}

test("local users can change their password and then sign in with the new one", async () => {
  const ctx = await buildLocal();
  try {
    const session = await loginAs(ctx.app, "gus", "secret");
    assert.equal(session.canChangePassword, true);
    assert.equal(session.subjectId, "local:gus");

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: session.cookie },
    });
    assert.equal(me.statusCode, 200);
    assert.equal((me.json() as { canChangePassword: boolean }).canChangePassword, true);

    const changed = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      payload: { currentPassword: "secret", newPassword: "newer-secret" },
    });
    assert.equal(changed.statusCode, 200);
    assert.deepEqual(changed.json(), { ok: true });

    const stillAuthed = await ctx.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: session.cookie },
    });
    assert.equal(stillAuthed.statusCode, 200);

    const csrfOld = await ctx.app.inject({ method: "GET", url: "/api/auth/csrf" });
    const csrfOldBody = csrfOld.json() as { csrfToken: string };
    const rejected = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { cookie: cookiePair(csrfOld, "rbi_csrf"), "x-csrf-token": csrfOldBody.csrfToken },
      payload: { username: "gus", password: "secret" },
    });
    assert.equal(rejected.statusCode, 401);

    const csrfNew = await ctx.app.inject({ method: "GET", url: "/api/auth/csrf" });
    const csrfNewBody = csrfNew.json() as { csrfToken: string };
    const accepted = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { cookie: cookiePair(csrfNew, "rbi_csrf"), "x-csrf-token": csrfNewBody.csrfToken },
      payload: { username: "gus", password: "newer-secret" },
    });
    assert.equal(accepted.statusCode, 200);
  } finally {
    await ctx.close();
  }
});

test("password change rejects bad current password, unchanged password, and SSO subjects", async () => {
  const ctx = await buildLocal();
  try {
    const session = await loginAs(ctx.app, "gus", "secret");

    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      payload: { currentPassword: "nope", newPassword: "newer-secret" },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error, "invalid_current_password");

    const same = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      payload: { currentPassword: "secret", newPassword: "secret" },
    });
    assert.equal(same.statusCode, 400);
    assert.equal(same.json().error, "password_unchanged");

    // Simulate a SAML session: same username display, but saml subject and no local password path.
    const samlSession = ctx.sessions.create({
      username: "sso-user",
      role: "user",
      subjectId: "saml:sso-user@example.com",
    });
    const forbidden = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: {
        cookie: `rbi_session=${samlSession.id}`,
        "x-csrf-token": samlSession.csrfToken,
      },
      payload: { currentPassword: "anything", newPassword: "something-else" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error, "password_change_unavailable");

    const samlMe = await ctx.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `rbi_session=${samlSession.id}` },
    });
    assert.equal(samlMe.statusCode, 200);
    assert.equal((samlMe.json() as { canChangePassword: boolean }).canChangePassword, false);
  } finally {
    await ctx.close();
  }
});
