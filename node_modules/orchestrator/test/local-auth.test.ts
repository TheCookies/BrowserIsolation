import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalAuthProvider, hashAuthUsers, parseAuthUsers } from "../src/auth/local-provider";
import { createLocalUserStore, seedLocalUsersIfEmpty } from "../src/auth/local-user-store";
import { openDatabase } from "../src/db";

test("parseAuthUsers accepts the documented accounts and colons inside passwords", () => {
  const users = parseAuthUsers("admin:admin:admin, user:user:user, ada:sec:ret:admin");
  assert.deepEqual(
    users.map((user) => user.username),
    ["admin", "user", "ada"],
  );
  assert.equal(users[2]?.password, "sec:ret");
  assert.equal(users[2]?.role, "admin");
});

test("parseAuthUsers rejects empty, duplicate, and unknown roles", () => {
  assert.throws(() => parseAuthUsers("  "), /empty/);
  assert.throws(() => parseAuthUsers("admin:admin"), /username:password:role/);
  assert.throws(() => parseAuthUsers("admin:admin:admin,admin:other:user"), /more than once/);
  assert.throws(() => parseAuthUsers("admin:admin:root"), /user or admin/);
  assert.throws(() => parseAuthUsers("bad name:secret:user"), /not allowed/);
});

test("passwords are stored as bcrypt hashes and checked with bcrypt", async () => {
  const hashed = await hashAuthUsers("admin:admin:admin,user:user:user", 4);
  const admin = hashed.get("admin");
  assert.ok(admin);
  assert.notEqual(admin.passwordHash, "admin");
  assert.match(admin.passwordHash, /^\$2[aby]\$/);
  assert.equal(await bcrypt.compare("admin", admin.passwordHash), true);
  assert.equal(await bcrypt.compare("user", admin.passwordHash), false);

  const dir = mkdtempSync(path.join(tmpdir(), "rbi-local-auth-"));
  try {
    const db = openDatabase(path.join(dir, "rbi.sqlite"));
    const users = createLocalUserStore(db);
    await seedLocalUsersIfEmpty(users, "admin:admin:admin,user:user:user", 4);
    const auth = await createLocalAuthProvider(users, 4);
    assert.deepEqual(await auth.authenticate("admin", "admin"), {
      username: "admin",
      role: "admin",
      subjectId: "local:admin",
    });
    assert.deepEqual(await auth.authenticate("user", "user"), {
      username: "user",
      role: "user",
      subjectId: "local:user",
    });
    assert.equal(await auth.authenticate("admin", "user"), null);
    assert.equal(await auth.authenticate("user", "admin"), null);
    assert.equal(await auth.authenticate("missing", "admin"), null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedLocalUsersIfEmpty only runs once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-seed-"));
  try {
    const db = openDatabase(path.join(dir, "rbi.sqlite"));
    const users = createLocalUserStore(db);
    assert.equal(await seedLocalUsersIfEmpty(users, "admin:admin:admin", 4), 1);
    assert.equal(await seedLocalUsersIfEmpty(users, "other:other:user", 4), 0);
    assert.equal(users.list().length, 1);
    assert.equal(users.list()[0]?.username, "admin");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
