import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config";

function withDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-config-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadConfig requires AUTH_USERS and applies cookie and port settings", () => {
  const { dir, cleanup } = withDir();
  try {
    const config = loadConfig(
      {
        AUTH_USERS: "admin:admin:admin, user:user:user",
        PORT: "3000",
        COOKIE_SECURE: "true",
        TRUST_PROXY: "yes",
        SESSION_TTL_HOURS: "2",
        BCRYPT_ROUNDS: "10",
        DATABASE_PATH: "./data/app.sqlite",
        WEBRTC_PORT_RANGE: "52010-52020",
        BROWSER_MEMORY: "1g",
        PUBLIC_IP: "10.0.0.5",
      },
      dir,
    );
    assert.equal(config.port, 3000);
    assert.equal(config.cookieSecure, true);
    assert.equal(config.trustProxy, true);
    assert.equal(config.sessionTtlMs, 2 * 60 * 60 * 1000);
    assert.equal(config.bcryptRounds, 10);
    assert.equal(config.databasePath, path.join(dir, "data", "app.sqlite"));
    assert.equal(config.staticDir, null);
    assert.equal(config.cookieName, "rbi_session");
    assert.equal(config.webrtcPortStart, 52010);
    assert.equal(config.webrtcPortEnd, 52020);
    assert.equal(config.browserMemoryBytes, 1024 ** 3);
    assert.equal(config.publicIp, "10.0.0.5");
    assert.equal(config.desktopScreen, "1280x720@30");
    assert.equal(config.browserNanoCpus, 3e9);
    assert.equal(config.allowClipboard, false);
    assert.equal(config.allowDownloads, false);
    assert.equal(config.profileDataDir, "");
  } finally {
    cleanup();
  }
});

test("loadConfig resolves PROFILE_DATA_DIR onto the host filesystem", () => {
  const { dir, cleanup } = withDir();
  try {
    const config = loadConfig(
      {
        AUTH_USERS: "admin:admin:admin",
        PROFILE_DATA_DIR: "/var/lib/browser-isolation/profiles",
      },
      dir,
    );
    assert.equal(config.profileDataDir, "/var/lib/browser-isolation/profiles");
  } finally {
    cleanup();
  }
});

test("loadConfig accepts security transfer toggles", () => {
  const { dir, cleanup } = withDir();
  try {
    const config = loadConfig(
      {
        AUTH_USERS: "admin:admin:admin",
        ALLOW_CLIPBOARD: "true",
        ALLOW_DOWNLOADS: "yes",
      },
      dir,
    );
    assert.equal(config.allowClipboard, true);
    assert.equal(config.allowDownloads, true);
  } finally {
    cleanup();
  }
});

test("loadConfig rejects a bad role and a bad port", () => {
  const { dir, cleanup } = withDir();
  try {
    assert.throws(() => loadConfig({ AUTH_USERS: "admin:admin:root" }, dir), /user or admin/);
    assert.throws(
      () => loadConfig({ AUTH_USERS: "admin:admin:admin", PORT: "0" }, dir),
      /PORT/,
    );
    assert.throws(
      () => loadConfig({ AUTH_USERS: "admin:admin:admin", COOKIE_SECURE: "maybe" }, dir),
      /COOKIE_SECURE/,
    );
  } finally {
    cleanup();
  }
});
