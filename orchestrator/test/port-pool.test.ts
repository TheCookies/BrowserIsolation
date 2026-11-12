import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { openDatabase } from "../src/db";
import { createPortPool } from "../src/port-pool";
import { sampleSession } from "./helpers";

test("in-flight allocations do not share a port before the session row exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-ports-"));
  const db = openDatabase(path.join(dir, "rbi.sqlite"));
  try {
    const pool = createPortPool(db, 52000, 52002);
    const first = pool.allocate();
    const second = pool.allocate();
    assert.equal(first, 52000);
    assert.equal(second, 52001);

    pool.release(second);
    assert.equal(pool.allocate(), 52001);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a committed session keeps its port after the in-flight hold is released", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-ports-commit-"));
  const db = openDatabase(path.join(dir, "rbi.sqlite"));
  try {
    const pool = createPortPool(db, 52000, 52002);
    const store = createBrowserSessionStore(db);
    const port = pool.allocate();
    store.insert(
      sampleSession({
        id: "session-port",
        containerId: "container-port",
        containerName: "rbi-port",
        webrtcPort: port,
        workerId: "local",
      }),
    );
    pool.release(port);

    const next = pool.allocate();
    assert.notEqual(next, port);

    store.delete("session-port");
    pool.release(next);
    assert.equal(pool.allocate(), port);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
