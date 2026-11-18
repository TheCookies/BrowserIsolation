/**
 * Remote browser cursor frames from Neko's WebRTC data channel.
 *
 * The server sends these big-endian (server/internal/webrtc/payload):
 *   OP_CURSOR_POSITION 0x01 — header + uint16 x, uint16 y
 *   OP_CURSOR_IMAGE    0x02 — header + uint16 width, height, xhot, yhot + PNG
 * The 3-byte header is opcode + uint16 length. Image bytes start at offset 11.
 *
 * Prefer CSS `cursor: url(…) x y` (compositor-native) over a JS-positioned
 * `<img>` sprite. The sprite always feels floaty; the OS cursor does not.
 * Hotspot is clamped to the image bounds so browsers accept the declaration.
 */

export type RemoteCursorImage = {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  png: Uint8Array;
};

export type RemoteCursorFrame =
  | { type: "position"; x: number; y: number }
  | { type: "image"; image: RemoteCursorImage };

const OP_CURSOR_POSITION = 0x01;
const OP_CURSOR_IMAGE = 0x02;

export function parseRemoteCursorFrame(data: ArrayBuffer): RemoteCursorFrame | null {
  if (data.byteLength < 3) return null;
  const view = new DataView(data);
  const op = view.getUint8(0);
  if (op === OP_CURSOR_POSITION) {
    if (data.byteLength < 7) return null;
    return { type: "position", x: view.getUint16(3), y: view.getUint16(5) };
  }
  if (op === OP_CURSOR_IMAGE) {
    if (data.byteLength < 11) return null;
    return {
      type: "image",
      image: {
        width: view.getUint16(3),
        height: view.getUint16(5),
        hotspotX: view.getUint16(7),
        hotspotY: view.getUint16(9),
        png: new Uint8Array(data.slice(11)),
      },
    };
  }
  return null;
}

/** A blank or 1×1 cursor means the remote browser hid the pointer. */
export function isDrawableCursor(image: RemoteCursorImage): boolean {
  return (
    image.width > 1 &&
    image.height > 1 &&
    image.width <= 256 &&
    image.height <= 256 &&
    image.png.byteLength >= 8
  );
}

export type CursorSpritePlacement = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Place the cursor bitmap so its hotspot sits on the pointer.
 * `pointerX`/`pointerY` and the box are CSS pixels of the stage.
 * The bitmap and hotspot are remote-screen pixels, scaled to that box.
 * Kept for tests / fallback; the live viewer uses {@link cssCursorValue}.
 */
export function placeCursorSprite(input: {
  pointerX: number;
  pointerY: number;
  boxWidth: number;
  boxHeight: number;
  screenWidth: number;
  screenHeight: number;
  imageWidth: number;
  imageHeight: number;
  hotspotX: number;
  hotspotY: number;
}): CursorSpritePlacement | null {
  const { boxWidth, boxHeight, screenWidth, screenHeight } = input;
  if (boxWidth <= 0 || boxHeight <= 0 || screenWidth <= 0 || screenHeight <= 0) return null;
  const scaleX = boxWidth / screenWidth;
  const scaleY = boxHeight / screenHeight;
  return {
    left: input.pointerX - input.hotspotX * scaleX,
    top: input.pointerY - input.hotspotY * scaleY,
    width: input.imageWidth * scaleX,
    height: input.imageHeight * scaleY,
  };
}

/** CSS `cursor` value for a remote bitmap, or `none` / `default`. */
export function cssCursorValue(image: RemoteCursorImage | null, objectUrl: string | null): string {
  if (!image) return "default";
  if (!isDrawableCursor(image) || !objectUrl) return "none";
  const maxX = Math.max(0, image.width - 1);
  const maxY = Math.max(0, image.height - 1);
  const hotX = Math.min(Math.max(0, Math.round(image.hotspotX)), maxX);
  const hotY = Math.min(Math.max(0, Math.round(image.hotspotY)), maxY);
  return `url("${objectUrl}") ${hotX} ${hotY}, default`;
}
