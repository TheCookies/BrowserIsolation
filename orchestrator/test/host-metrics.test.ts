import assert from "node:assert/strict";
import test from "node:test";
import { collectHostMetrics } from "../src/host-metrics";

test("collectHostMetrics returns cpu memory disk and network samples", async () => {
  const metrics = await collectHostMetrics(["/"]);
  assert.ok(metrics.cpu.cores >= 1);
  assert.ok(metrics.memory.totalBytes > 0);
  assert.ok(metrics.memory.usedPercent >= 0 && metrics.memory.usedPercent <= 100);
  assert.ok(metrics.disks.length >= 1);
  assert.equal(metrics.disks[0]?.path, "/");
  assert.ok(metrics.disks[0]!.totalBytes > 0);
  if (metrics.cpu.usagePercent !== null) {
    assert.ok(metrics.cpu.usagePercent >= 0 && metrics.cpu.usagePercent <= 100);
  }
  assert.ok(metrics.network.sampleMs >= 100);
  assert.ok(Array.isArray(metrics.network.interfaces));
  for (const iface of metrics.network.interfaces) {
    assert.ok(iface.name.length > 0);
    assert.notEqual(iface.name, "lo");
    assert.ok(iface.rxBytes >= 0);
    assert.ok(iface.txBytes >= 0);
    if (iface.rxBytesPerSec !== null) assert.ok(iface.rxBytesPerSec >= 0);
    if (iface.txBytesPerSec !== null) assert.ok(iface.txBytesPerSec >= 0);
  }
});
