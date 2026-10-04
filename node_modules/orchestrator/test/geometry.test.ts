import assert from "node:assert/strict";
import test from "node:test";
import { computeStageSize, VIEWPORT_SLACK_PX } from "../../web/src/sessionLayout.ts";
import {
  mapPoint,
  normalizeWheelDelta,
  preferredScreenSize,
  screensEqual,
} from "../../web/src/viewer/geometry.ts";

test("computeStageSize subtracts 5px slack from width and height", () => {
  assert.equal(VIEWPORT_SLACK_PX, 5);
  const measured = computeStageSize(1600, 900, 48);
  assert.equal(measured.viewportWidth, 1600);
  assert.equal(measured.viewportHeight, 900);
  assert.equal(measured.toolbarHeight, 48);
  assert.equal(measured.stageWidth, 1600 - 5);
  assert.equal(measured.stageHeight, 900 - 48 - 5);
});

test("preferredScreenSize follows stage width and height without 1080p cap", () => {
  const wide = preferredScreenSize(2560, 900, 30);
  assert.equal(wide.width % 8, 0);
  assert.equal(wide.width, 2560);
  assert.equal(wide.height, 900);
  assert.equal(wide.rate, 30);

  const narrow = preferredScreenSize(1000, 700, 30);
  assert.equal(narrow.width, 1000);
  assert.equal(narrow.height, 700);
  assert.equal(screensEqual(narrow, { width: 1000, height: 700, rate: 30 }), true);
});

test("mapPoint maps against the full overlay", () => {
  const video = { videoWidth: 1600, videoHeight: 900 };
  const surface = {
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: 800,
        height: 450,
        right: 800,
        bottom: 450,
        x: 0,
        y: 0,
        toJSON() {
          return this;
        },
      };
    },
  };

  const center = mapPoint(400, 225, surface, { width: 1600, height: 900, rate: 30 }, video);
  assert.equal(center.x, 800);
  assert.equal(center.y, 450);
});

test("normalizeWheelDelta matches Neko clamp/invert defaults", () => {
  const pixel = normalizeWheelDelta(0, 40, 0);
  assert.equal(pixel.y, -10);
});
