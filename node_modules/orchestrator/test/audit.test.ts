import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAuditStore,
  defaultAuditEnabledActions,
  formatAuditEnabledActions,
  parseAuditEnabledActions,
} from "../src/audit-store";
import { openDatabase } from "../src/db";
import { createSettingsStore } from "../src/settings-store";
import { testConfig } from "./helpers";

test("parseAuditEnabledActions defaults and filters unknown ids", () => {
  assert.deepEqual(parseAuditEnabledActions(undefined), defaultAuditEnabledActions());
  assert.deepEqual(parseAuditEnabledActions(""), defaultAuditEnabledActions());
  assert.deepEqual(parseAuditEnabledActions('["join","nope","login","join"]'), ["join", "login"]);
  assert.deepEqual(parseAuditEnabledActions("[]"), []);
  assert.throws(() => parseAuditEnabledActions("{"), /JSON array/);
});

test("audit store skips disabled actions and supports filters", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-audit-"));
  try {
    const db = openDatabase(path.join(dir, "rbi.sqlite"));
    const enabled = new Set<string>(["join", "login"]);
    const audit = createAuditStore(db, {
      isEnabled: (action) => enabled.has(action),
    });

    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const t1 = Date.UTC(2026, 0, 2, 12, 0, 0);
    const t2 = Date.UTC(2026, 0, 3, 12, 0, 0);

    assert.equal(
      audit.record({
        actorUsername: "ada",
        action: "terminate",
        at: t0,
      }),
      null,
    );
    assert.ok(
      audit.record({
        actorUsername: "ada",
        action: "join",
        ownerUsername: "gus",
        at: t1,
      }),
    );
    assert.ok(
      audit.record({
        actorUsername: "gus",
        action: "login",
        ownerUsername: "gus",
        at: t2,
      }),
    );

    const all = audit.list({ limit: 50 });
    assert.equal(all.length, 2);

    const byActor = audit.list({ actor: "ADA", limit: 50 });
    assert.equal(byActor.length, 1);
    assert.equal(byActor[0]?.action, "join");

    const byAction = audit.list({ action: "login", limit: 50 });
    assert.equal(byAction.length, 1);
    assert.equal(byAction[0]?.actorUsername, "gus");

    const byRange = audit.list({ from: t2, to: t2, limit: 50 });
    assert.equal(byRange.length, 1);
    assert.equal(byRange[0]?.action, "login");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings persist AUDIT_ENABLED_ACTIONS onto config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-audit-settings-"));
  try {
    const config = testConfig({ databasePath: path.join(dir, "rbi.sqlite") });
    const db = openDatabase(config.databasePath);
    const settings = createSettingsStore(db, config);

    const result = settings.update({
      AUDIT_ENABLED_ACTIONS: formatAuditEnabledActions(["join", "login"]),
    });
    assert.deepEqual(result.updated, ["AUDIT_ENABLED_ACTIONS"]);
    assert.deepEqual(config.auditEnabledActions, ["join", "login"]);

    const fresh = testConfig({ databasePath: config.databasePath });
    const settings2 = createSettingsStore(openDatabase(config.databasePath), fresh);
    settings2.hydrateConfig();
    assert.deepEqual(fresh.auditEnabledActions, ["join", "login"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
