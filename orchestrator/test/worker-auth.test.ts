import assert from "node:assert/strict";
import test from "node:test";
import { safeEqual } from "../src/security";

/** Mirrors worker-agent authorize() acceptance rules. */
function authorize(requestToken: string | undefined, accepted: string[]): boolean {
  if (!requestToken || accepted.length === 0) return false;
  const value = requestToken.startsWith("Bearer ") ? requestToken.slice(7) : requestToken;
  return accepted.some((expected) => expected.length > 0 && safeEqual(value, expected));
}

test("worker agent accepts shared enroll token or legacy worker token", () => {
  const enroll = "rbi_enroll_shared";
  const legacy = "old-random-token";
  assert.equal(authorize(`Bearer ${enroll}`, [enroll, legacy]), true);
  assert.equal(authorize(`Bearer ${legacy}`, [enroll, legacy]), true);
  assert.equal(authorize("Bearer wrong", [enroll, legacy]), false);
  assert.equal(authorize(undefined, [enroll]), false);
});

test("shared enroll token alone is enough after rollout", () => {
  const enroll = "rbi_enroll_shared";
  assert.equal(authorize(`Bearer ${enroll}`, [enroll]), true);
  assert.equal(authorize("Bearer old-random-token", [enroll]), false);
});
