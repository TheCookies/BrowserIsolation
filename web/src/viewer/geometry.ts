import type { ScreenResolution } from "./types";

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
/** Allow wide/tall monitors; Xorg still rounds width to multiples of 8. */
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

/** Match the host stage in CSS pixels (width + height), with Xorg-safe rounding. */
export function preferredScreenSize(
  areaWidth: number,
  areaHeight: number,
  rate = 30,
): ScreenResolution {
  let width = Math.floor(areaWidth / 8) * 8;
  let height = Math.round(areaHeight) - (Math.round(areaHeight) % 2);
  width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
  height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));
  return { width, height, rate };
}

export function screensEqual(a: ScreenResolution | null, b: ScreenResolution): boolean {
  if (!a) return false;
  return a.width === b.width && a.height === b.height && a.rate === b.rate;
}

/**
 * Map pointer against the full overlay — correct when the video fills the stage.
 */
export function mapPoint(
  clientX: number,
  clientY: number,
  surface: Pick<HTMLElement, "getBoundingClientRect">,
  resolution: ScreenResolution | null,
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">,
): { x: number; y: number } {
  const rect = surface.getBoundingClientRect();
  const width = resolution?.width || video.videoWidth || 1280;
  const height = resolution?.height || video.videoHeight || 720;
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: Math.round((width / rect.width) * (clientX - rect.left)),
    y: Math.round((height / rect.height) * (clientY - rect.top)),
  };
}

/** Neko default scroll sensitivity / invert (client settings defaults). */
export const NEKO_SCROLL_SENSITIVITY = 10;
export const NEKO_SCROLL_INVERT = true;
export const NEKO_WHEEL_LINE_HEIGHT = 19;
export const NEKO_WHEEL_THROTTLE_MS = 100;

export function normalizeWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  sensitivity = NEKO_SCROLL_SENSITIVITY,
  invert = NEKO_SCROLL_INVERT,
): { x: number; y: number } {
  let x = deltaX;
  let y = deltaY;
  if (deltaMode !== 0) {
    x *= NEKO_WHEEL_LINE_HEIGHT;
    y *= NEKO_WHEEL_LINE_HEIGHT;
  }
  if (invert) {
    x *= -1;
    y *= -1;
  }
  x = Math.min(Math.max(x, -sensitivity), sensitivity);
  y = Math.min(Math.max(y, -sensitivity), sensitivity);
  return { x, y };
}
