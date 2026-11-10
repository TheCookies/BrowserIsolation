import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clearProfileLockFiles } from "../src/docker/profile-locks";

test("clearProfileLockFiles removes Firefox and Chromium locks, keeps profile data", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rbi-profile-locks-"));
  try {
    writeFileSync(path.join(root, ".parentlock"), "locked");
    writeFileSync(path.join(root, "prefs.js"), "user_pref('foo', 1);");
    writeFileSync(path.join(root, "SingletonLock"), "host-123");
    writeFileSync(path.join(root, "SingletonCookie"), "cookie");
    try {
      symlinkSync("127.0.0.1:12345", path.join(root, "lock"));
    } catch {
      writeFileSync(path.join(root, "lock"), "fallback");
    }
    const nested = path.join(root, "Default");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "SingletonLock"), "nested");
    writeFileSync(path.join(nested, "Preferences"), "{}");

    const cleared = clearProfileLockFiles(root);
    const names = cleared.map((item) => item.name).sort();
    assert.deepEqual(names, [
      ".parentlock",
      "SingletonCookie",
      "SingletonLock",
      "SingletonLock",
      "lock",
    ]);
    assert.equal(existsSync(path.join(root, "prefs.js")), true);
    assert.equal(existsSync(path.join(nested, "Preferences")), true);
    assert.equal(existsSync(path.join(root, ".parentlock")), false);
    assert.equal(existsSync(path.join(root, "lock")), false);
    assert.equal(existsSync(path.join(root, "SingletonLock")), false);
    assert.equal(existsSync(path.join(nested, "SingletonLock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearProfileLockFiles is a no-op for missing directories", () => {
  assert.deepEqual(clearProfileLockFiles(path.join(tmpdir(), "rbi-missing-profile-dir")), []);
});
