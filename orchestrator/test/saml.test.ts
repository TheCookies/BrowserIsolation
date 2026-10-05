import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Profile } from "@node-saml/node-saml";
import { buildApp } from "../src/app";
import type { AuthProvider } from "../src/auth/provider";
import {
  assertSamlReady,
  generateSpMetadata,
  mapSamlRole,
  normalizeIdpCert,
  profileToUser,
  resolveGroups,
  resolveUsername,
  samlServiceUrls,
} from "../src/auth/saml";
import { openDatabase } from "../src/db";
import { createSessionStore } from "../src/session-store";
import { createUserPreferencesStore } from "../src/user-preferences";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { createBrowserSessionService } from "../src/browser-sessions";
import { stubRuntime, testConfig, testPlacement, testSideChannels } from "./helpers";

const SAMPLE_CERT = `-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUS99kbDkiwrSpUS1FzIDaqxDE4hAwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwHhcNMjYxMDAzMjM0MDUzWhcNMzYwOTMw
MjM0MDUzWjATMREwDwYDVQQDDAh0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBALXyvECOEoznTP8sHLZ/ElOSsFunPXrC/+zQpWuJ4bVWe4Lb
s2wcq9SwAJvZSW9v744E+9dHCVk7+8XCt4Jdnltn/Br/L7YFH3rFd1fjlStvFmx/
S89AmR7Bym1L1q0CcfzEkT367JW2OLkOhtRBhFVR75Kz9I37mYZLXu3SJTKCrnw1
oZMiDiWHsQbWtENTq5KnUiEHUO60Ne3T8DbnnNFeqasRy9t70SxeH1oTpeYh/3Ni
sKW9qm560wTT0Koj22kl2zOSi6aHEB6NFP1h45GHGA7lRVuf/h3vBGdAmRqCzJxd
y0xew15GTYByiD6AnT5AV5oNWeTKRk+Bk9RN76kCAwEAAaNTMFEwHQYDVR0OBBYE
FFncWqMgywaUILOTu6Uj/zeICKLnMB8GA1UdIwQYMBaAFFncWqMgywaUILOTu6Uj
/zeICKLnMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBACi3sZxk
KBf5AwElFfcKUY3sDxdYZEsnks8/g6Z+LgYgWOfdJ2S6rqcq+i7t2B9LmsMnMOnl
HRWbXMsI5beDu245q990v1WMW+9lFB9OWrYsj2Tp9y7QyDuvx6o2j2HlUTf+TvIW
wXwfw4O15kqU/M7gfvajPPIcGr6u9vDBy7OiTt9RyCi5QNEXSdZOoirx5KfT8OFf
E6aonp18JgqmIzqsXi4dnZWDfYjscaiYLZMWSukg1sKWM/5jCNOVOpam8bVXCjwb
WH73OZQ300YrOeN5HP2SkuGIs6p5esbxEmwPJgFb4FvzugnVYUyR1XJjPzneCnfy
7gItd8CSEwVX85w=
-----END CERTIFICATE-----`;

test("normalizeIdpCert wraps bare base64", () => {
  const bare = SAMPLE_CERT.replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  const pem = normalizeIdpCert(bare);
  assert.match(pem, /BEGIN CERTIFICATE/);
  assert.match(pem, /END CERTIFICATE/);
});

test("assertSamlReady requires base url entry point and cert", () => {
  const config = testConfig({ samlEnabled: true });
  assert.throws(() => assertSamlReady(config), /PUBLIC_BASE_URL/);
  config.publicBaseUrl = "https://rbi.example.com";
  assert.throws(() => assertSamlReady(config), /SAML_ENTRY_POINT/);
  config.samlEntryPoint = "https://idp.example.com/sso";
  assert.throws(() => assertSamlReady(config), /SAML_IDP_CERT/);
  config.samlIdpCert = SAMPLE_CERT;
  assert.doesNotThrow(() => assertSamlReady(config));
});

test("role mapping and username/group resolution", () => {
  const profile = {
    issuer: "https://idp.example.com",
    nameID: "alice@example.com",
    nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    email: "alice@example.com",
    groups: ["staff", "rbi-admins"],
  } as Profile;

  assert.equal(resolveUsername(profile, ""), "alice@example.com");
  assert.deepEqual(resolveGroups(profile, ""), ["staff", "rbi-admins"]);
  assert.equal(mapSamlRole(["staff", "rbi-admins"], "rbi-admins"), "admin");
  assert.equal(mapSamlRole(["staff"], "rbi-admins"), "user");

  const user = profileToUser(
    profile,
    testConfig({
      samlAdminGroup: "rbi-admins",
    }),
  );
  assert.equal(user.username, "alice@example.com");
  assert.equal(user.role, "admin");
  assert.match(user.subjectId, /^saml:/);
});

test("SP metadata includes ACS and entity id", () => {
  const config = testConfig({
    samlEnabled: true,
    publicBaseUrl: "https://rbi.example.com",
    samlEntryPoint: "https://idp.example.com/sso",
    samlIdpCert: SAMPLE_CERT,
  });
  const urls = samlServiceUrls(config);
  const xml = generateSpMetadata(config);
  assert.match(xml, /EntityDescriptor/);
  assert.ok(xml.includes(urls.acsUrl));
  assert.ok(xml.includes(urls.entityId));
});

test("settings reject enabling SAML without required fields", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-saml-set-"));
  const config = testConfig({ databasePath: path.join(dir, "rbi.sqlite") });
  const db = openDatabase(config.databasePath);
  const side = testSideChannels(db, config);
  const preferences = createUserPreferencesStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const store = createBrowserSessionStore(db);
  const runtime = stubRuntime();
  const { placement, workerStore } = testPlacement(db, config, runtime);
  const auth: AuthProvider = {
    async authenticate(username, password) {
      if (username === "ada" && password === "secret") {
        return { username: "ada", role: "admin", subjectId: "local:ada" };
      }
      return null;
    },
  };
  const browsers = createBrowserSessionService({
    config,
    store,
    placement,
    neko: {
      async waitUntilReady() {},
      async login() {
        return { token: "t" };
      },
    },
    preferences,
  });

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
      cookie: `${csrf.cookies.find((c) => c.name === "rbi_csrf")!.name}=${csrf.cookies.find((c) => c.name === "rbi_csrf")!.value}`,
      "x-csrf-token": (csrf.json() as { csrfToken: string }).csrfToken,
    },
    payload: { username: "ada", password: "secret" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = `${login.cookies.find((c) => c.name === "rbi_session")!.name}=${login.cookies.find((c) => c.name === "rbi_session")!.value}`;

  const bad = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    headers: {
      cookie,
      "x-csrf-token": (login.json() as { csrfToken: string }).csrfToken,
      "content-type": "application/json",
    },
    payload: { settings: { SAML_ENABLED: "true" } },
  });
  assert.equal(bad.statusCode, 400);

  const methods = await app.inject({ method: "GET", url: "/api/auth/methods" });
  assert.equal(methods.statusCode, 200);
  assert.equal((methods.json() as { saml: boolean }).saml, false);

  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
