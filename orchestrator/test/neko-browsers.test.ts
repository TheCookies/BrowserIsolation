import assert from "node:assert/strict";
import test from "node:test";
import {
  imageForNekoBrowser,
  normalizeBrowserId,
  parseEnabledBrowsers,
  NEKO_BROWSERS,
} from "../src/neko-browsers";

test("catalog covers official Neko browsers", () => {
  const ids = NEKO_BROWSERS.map((browser) => browser.id);
  assert.ok(ids.includes("google-chrome"));
  assert.ok(ids.includes("firefox"));
  assert.ok(ids.includes("brave"));
  assert.ok(ids.includes("opera"));
  assert.equal(normalizeBrowserId("chrome"), "google-chrome");
  assert.equal(normalizeBrowserId("Google-Chrome"), "google-chrome");
});

test("parseEnabledBrowsers defaults and rejects empty", () => {
  assert.deepEqual(parseEnabledBrowsers(undefined), ["google-chrome", "firefox", "brave"]);
  assert.deepEqual(parseEnabledBrowsers("chrome,brave"), ["google-chrome", "brave"]);
  assert.throws(() => parseEnabledBrowsers("safari"), /at least one/);
});

test("image refs use GHCR and tag", () => {
  const chrome = NEKO_BROWSERS.find((browser) => browser.id === "google-chrome")!;
  assert.equal(imageForNekoBrowser(chrome, "latest"), "ghcr.io/m1k1o/neko/google-chrome:latest");
});
