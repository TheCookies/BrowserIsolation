import assert from "node:assert/strict";
import test from "node:test";
import {
  isDrawableCursor,
  parseRemoteCursorFrame,
  placeCursorSprite,
} from "../../web/src/viewer/cursor.ts";

test("parseRemoteCursorFrame reads big-endian position and image frames", () => {
  const position = parseRemoteCursorFrame(Uint8Array.from([1, 0, 4, 0x01, 0x02, 0x03, 0x04]).buffer);
  assert.deepEqual(position, { type: "position", x: 258, y: 772 });

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const image = parseRemoteCursorFrame(
    Uint8Array.from([2, 0, 12, 0, 16, 0, 20, 0, 3, 0, 5, ...png]).buffer,
  );
  assert.equal(image?.type, "image");
  if (image?.type !== "image") return;
  assert.equal(image.image.width, 16);
  assert.equal(image.image.height, 20);
  assert.equal(image.image.hotspotX, 3);
  assert.equal(image.image.hotspotY, 5);
  assert.deepEqual([...image.image.png], png);
  assert.equal(isDrawableCursor(image.image), true);
});

test("parseRemoteCursorFrame ignores truncated and unknown frames", () => {
  assert.equal(parseRemoteCursorFrame(Uint8Array.from([1, 0, 4]).buffer), null);
  assert.equal(parseRemoteCursorFrame(Uint8Array.from([2, 0, 12, 0, 16]).buffer), null);
  assert.equal(parseRemoteCursorFrame(Uint8Array.from([9, 0, 0]).buffer), null);
});

test("a 1x1 cursor is the remote browser hiding the pointer", () => {
  const frame = parseRemoteCursorFrame(
    Uint8Array.from([2, 0, 11, 0, 1, 0, 1, 0, 0, 0, 0, 0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer,
  );
  assert.equal(frame?.type, "image");
  if (frame?.type !== "image") return;
  assert.equal(isDrawableCursor(frame.image), false);
});

test("placeCursorSprite keeps the hotspot on the pointer when the stage is scaled", () => {
  const placed = placeCursorSprite({
    pointerX: 100,
    pointerY: 80,
    boxWidth: 800,
    boxHeight: 450,
    screenWidth: 1600,
    screenHeight: 900,
    imageWidth: 32,
    imageHeight: 32,
    hotspotX: 4,
    hotspotY: 8,
  });
  assert.ok(placed);
  assert.equal(placed.left, 98);
  assert.equal(placed.top, 76);
  assert.equal(placed.width, 16);
  assert.equal(placed.height, 16);
  // Hotspot lands back on the pointer after scaling.
  assert.equal(placed.left + 4 * (800 / 1600), 100);
  assert.equal(placed.top + 8 * (450 / 900), 80);
});

test("placeCursorSprite is 1:1 when the stage matches the remote screen", () => {
  const placed = placeCursorSprite({
    pointerX: 40,
    pointerY: 50,
    boxWidth: 1280,
    boxHeight: 720,
    screenWidth: 1280,
    screenHeight: 720,
    imageWidth: 24,
    imageHeight: 24,
    hotspotX: 1,
    hotspotY: 2,
  });
  assert.deepEqual(placed, { left: 39, top: 48, width: 24, height: 24 });
});
