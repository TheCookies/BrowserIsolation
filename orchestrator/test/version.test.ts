import assert from "node:assert/strict";
import test from "node:test";
import { getAppVersion } from "../src/version";

test("getAppVersion prefers baked APP_VERSION and git env", () => {
  const keys = ["APP_VERSION", "GIT_SHA", "GIT_SHA_SHORT", "GIT_COMMIT_TIME", "BUILD_TIME"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.APP_VERSION = "2026.10.29-abc1234";
  process.env.GIT_SHA = "abc1234fffffffffffffffffffffffffffffff";
  process.env.GIT_SHA_SHORT = "abc1234";
  process.env.GIT_COMMIT_TIME = "2026-10-29T16:00:00Z";
  process.env.BUILD_TIME = "2026-10-29T16:05:00Z";
  try {
    const info = getAppVersion();
    assert.equal(info.version, "2026.10.29-abc1234");
    assert.equal(info.gitShaShort, "abc1234");
    assert.equal(info.gitSha, "abc1234fffffffffffffffffffffffffffffff");
    assert.equal(info.gitCommitTime, "2026-10-29T16:00:00Z");
    assert.equal(info.builtAt, "2026-10-29T16:05:00Z");
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
