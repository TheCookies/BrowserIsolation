import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeResourceId,
  xDisplayForWebrtcPort,
} from "../src/docker/session-resources";

test("xDisplayForWebrtcPort is unique across the default WebRTC pool", () => {
  const start = 52000;
  const end = 52199;
  const seen = new Set<string>();
  for (let port = start; port <= end; port += 1) {
    const display = xDisplayForWebrtcPort(port);
    assert.match(display, /^:\d+$/);
    const n = Number(display.slice(1));
    assert.ok(n >= 100, `display ${display} should avoid :0–:99`);
    assert.equal(seen.has(display), false, `duplicate display ${display} for port ${port}`);
    seen.add(display);
  }
  assert.equal(seen.size, end - start + 1);
});

test("xDisplayForWebrtcPort rejects invalid ports", () => {
  assert.throws(() => xDisplayForWebrtcPort(0), /invalid_webrtc_port_for_display/);
  assert.throws(() => xDisplayForWebrtcPort(1.5), /invalid_webrtc_port_for_display/);
  assert.throws(() => xDisplayForWebrtcPort(-1), /invalid_webrtc_port_for_display/);
});

test("sanitizeResourceId keeps simple names and hashes tricky ones", () => {
  assert.equal(sanitizeResourceId("alice"), "alice");
  assert.equal(sanitizeResourceId("Alice"), "alice");
  assert.match(sanitizeResourceId("j.smith"), /^j-smith-[a-f0-9]{8}$/);
  assert.match(sanitizeResourceId("JSmith@corp.example"), /^jsmith-corp-example-[a-f0-9]{8}$/);
  assert.match(sanitizeResourceId("DOMAIN\\user"), /^domain-user-[a-f0-9]{8}$/);
  assert.match(sanitizeResourceId("  "), /^user-[a-f0-9]{8}$/);
  // Dot vs hyphen must not collapse to the same label.
  assert.notEqual(sanitizeResourceId("j.smith"), sanitizeResourceId("j-smith"));
  assert.ok(sanitizeResourceId("a".repeat(80)).length <= 48);
});
