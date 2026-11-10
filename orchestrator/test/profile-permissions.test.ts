import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureWritableProfileHostDir,
  NEKO_HOST_GID,
  NEKO_HOST_UID,
} from "../src/docker/profile-permissions";

test("ensureWritableProfileHostDir creates the profile path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rbi-profile-perms-"));
  try {
    const hostDir = path.join(root, "abc123", "firefox");
    ensureWritableProfileHostDir(hostDir);
    const st = statSync(hostDir);
    assert.ok(st.isDirectory());
    if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
      assert.equal(st.uid, NEKO_HOST_UID);
      assert.equal(st.gid, NEKO_HOST_GID);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
