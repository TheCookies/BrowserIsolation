import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserSessionStore } from "../src/browser-session-store";
import { openDatabase } from "../src/db";
import { createPortPool } from "../src/port-pool";
import { sampleSession } from "./helpers";

const range = { start: 52000, end: 52002 };

test("each subject reserves a distinct port and a repeat claim waits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-claims-"));
  const db = openDatabase(path.join(dir, "rbi.sqlite"));
  try {
    const store = createBrowserSessionStore(db);
    const alice = store.reserveLaunch({
      subjectId: "ldap:alice",
      workerId: "local",
      sessionId: "session-alice",
      portRange: range,
    });
    const bob = store.reserveLaunch({
      subjectId: "ldap:bob",
      workerId: "local",
      sessionId: "session-bob",
      portRange: range,
    });
    const again = store.reserveLaunch({
      subjectId: "ldap:alice",
      workerId: "local",
      sessionId: "session-alice-2",
      portRange: range,
    });

    assert.equal(alice.status, "reserved");
    assert.equal(bob.status, "reserved");
    if (alice.status !== "reserved" || bob.status !== "reserved") return;
    assert.equal(alice.webrtcPort, 52000);
    assert.equal(bob.webrtcPort, 52001);
    assert.deepEqual(again, { status: "busy", sessionId: "session-alice" });

    store.commitLaunch(
      "ldap:alice",
      sampleSession({
        id: "session-alice",
        ownerSubjectId: "ldap:alice",
        webrtcPort: alice.webrtcPort,
        workerId: "local",
      }),
    );
    assert.equal(store.getLaunchClaim("ldap:alice"), null);
    assert.equal(store.getBySubjectId("ldap:alice")?.id, "session-alice");

    const pool = createPortPool(db, range.start, range.end);
    const third = pool.allocate();
    assert.equal(third, 52002);
    pool.release(third);

    store.releaseLaunch("ldap:bob");
    assert.equal(store.getLaunchClaim("ldap:bob"), null);
    assert.equal(pool.allocate(), 52001);

    const rejoined = store.reserveLaunch({
      subjectId: "ldap:alice",
      workerId: "local",
      sessionId: "session-alice-3",
      portRange: range,
    });
    assert.equal(rejoined.status, "session");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a remote claim does not consume a local WebRTC port", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-claims-remote-"));
  const db = openDatabase(path.join(dir, "rbi.sqlite"));
  try {
    const store = createBrowserSessionStore(db);
    const remote = store.reserveLaunch({
      subjectId: "ldap:remote",
      workerId: "worker-1",
      sessionId: "session-remote",
    });
    const local = store.reserveLaunch({
      subjectId: "ldap:local",
      workerId: "local",
      sessionId: "session-local",
      portRange: range,
    });
    assert.equal(remote.status, "reserved");
    assert.equal(local.status, "reserved");
    if (remote.status !== "reserved" || local.status !== "reserved") return;
    assert.equal(remote.webrtcPort, 0);
    assert.equal(local.webrtcPort, 52000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired claims and a startup clear free their ports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-claims-expire-"));
  const db = openDatabase(path.join(dir, "rbi.sqlite"));
  try {
    const store = createBrowserSessionStore(db);
    db.prepare(
      `INSERT INTO launch_claims (subject_id, session_id, webrtc_port, worker_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ldap:stale", "session-stale", 52000, "local", Date.now() - 4 * 60_000);

    const fresh = store.reserveLaunch({
      subjectId: "ldap:fresh",
      workerId: "local",
      sessionId: "session-fresh",
      portRange: range,
    });
    assert.equal(fresh.status, "reserved");
    if (fresh.status !== "reserved") return;
    assert.equal(fresh.webrtcPort, 52000);
    assert.equal(store.getLaunchClaim("ldap:stale"), null);

    store.clearLaunchClaims();
    const tight = { start: 52000, end: 52001 };
    const reused = store.reserveLaunch({
      subjectId: "ldap:other",
      workerId: "local",
      sessionId: "session-other",
      portRange: tight,
    });
    assert.equal(reused.status, "reserved");
    if (reused.status !== "reserved") return;
    assert.equal(reused.webrtcPort, 52000);

    const second = store.reserveLaunch({
      subjectId: "ldap:second",
      workerId: "local",
      sessionId: "session-second",
      portRange: tight,
    });
    assert.equal(second.status, "reserved");
    if (second.status !== "reserved") return;
    assert.equal(second.webrtcPort, 52001);
    assert.throws(
      () =>
        store.reserveLaunch({
          subjectId: "ldap:third",
          workerId: "local",
          sessionId: "session-third",
          portRange: tight,
        }),
      /webrtc_port_pool_exhausted/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
