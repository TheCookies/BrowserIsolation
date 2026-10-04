import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db";
import { createSessionStore } from "../src/session-store";

test("sessions expire and logout deletes them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-session-"));
  const db = openDatabase(path.join(dir, "rbi.sqlite"));
  try {
    const expired = createSessionStore(db, -1_000);
    const stale = expired.create({ username: "ada", role: "admin", subjectId: "local:ada" });
    assert.equal(expired.get(stale.id), null);

    const store = createSessionStore(db, 60_000);
    const session = store.create({ username: "gus", role: "user", subjectId: "local:gus" });
    const loaded = store.get(session.id);
    assert.equal(loaded?.username, "gus");
    assert.equal(loaded?.role, "user");
    assert.notEqual(loaded?.csrfToken, session.id);
    store.delete(session.id);
    assert.equal(store.get(session.id), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
