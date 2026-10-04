import assert from "node:assert/strict";
import test from "node:test";
import { pickWorker, isWorkerOnline } from "../src/workers/scheduler";
import { parseWorkersEnv } from "../src/workers/store";
import type { WorkerRecord } from "../src/workers/types";

function worker(partial: Partial<WorkerRecord> & Pick<WorkerRecord, "id">): WorkerRecord {
  return {
    baseUrl: "",
    publicIp: "10.0.0.1",
    token: "",
    enabled: true,
    kind: "local",
    lastSeenAt: Date.now(),
    activeSessions: 0,
    ...partial,
  };
}

test("pickWorker prefers sticky online worker then least loaded", () => {
  const now = Date.now();
  const a = worker({ id: "a", kind: "remote", baseUrl: "http://a", token: "t", activeSessions: 2, lastSeenAt: now });
  const b = worker({ id: "b", kind: "remote", baseUrl: "http://b", token: "t", activeSessions: 0, lastSeenAt: now });
  const sticky = pickWorker([a, b], { stickyWorkerId: "a", now });
  assert.equal(sticky?.id, "a");

  const least = pickWorker([a, b], { now });
  assert.equal(least?.id, "b");
});

test("isWorkerOnline respects heartbeat TTL for remote workers", () => {
  const now = Date.now();
  const fresh = worker({
    id: "w",
    kind: "remote",
    baseUrl: "http://w",
    token: "t",
    lastSeenAt: now - 10_000,
  });
  const stale = worker({
    id: "w2",
    kind: "remote",
    baseUrl: "http://w2",
    token: "t",
    lastSeenAt: now - 60_000,
  });
  assert.equal(isWorkerOnline(fresh, now), true);
  assert.equal(isWorkerOnline(stale, now), false);
  assert.equal(isWorkerOnline(worker({ id: "local", kind: "local" }), now), true);
});

test("parseWorkersEnv validates entries", () => {
  const parsed = parseWorkersEnv("edge1|http://10.0.0.5:8090|10.0.0.5|secret");
  assert.deepEqual(parsed, [
    { id: "edge1", baseUrl: "http://10.0.0.5:8090", publicIp: "10.0.0.5", token: "secret" },
  ]);
  assert.throws(() => parseWorkersEnv("bad"), /id\|baseUrl/);
});
