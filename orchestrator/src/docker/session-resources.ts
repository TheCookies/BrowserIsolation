import { createHash } from "node:crypto";

/**
 * Per-session X display for Neko containers.
 *
 * Alma/Podman runs browsers with BROWSER_NETWORK_MODE=host. X11 abstract
 * sockets live in the network namespace, so every container that keeps the
 * image default DISPLAY=:99.0 fights over @/tmp/.X11-unix/X99. The first
 * session wins; the next one's Xorg never owns a display, xf86-input-neko
 * never creates its socket, and neko panics with "unable to connect to input
 * driver".
 *
 * WebRTC ports are already uniquely allocated per session on the host, so
 * derive DISPLAY from that port (race-free, no second allocator).
 */
export function xDisplayForWebrtcPort(webrtcPort: number): string {
  if (!Number.isInteger(webrtcPort) || webrtcPort < 1) {
    throw new Error("invalid_webrtc_port_for_display");
  }
  // Stay out of :0–:99 (common host / image defaults). Within any contiguous
  // pool shorter than 8900 ports, (port % 8900) is unique.
  return `:${100 + (webrtcPort % 8900)}`;
}

/**
 * Safe slug for Docker labels / resource names. Keep the original username for
 * UI and auth; never use this as the ownership key (use subjectId / profileStorageKey).
 */
export function sanitizeResourceId(raw: string, maxLength = 48): string {
  const trimmed = raw.trim().toLowerCase();
  const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
  const unchanged = slug === trimmed && trimmed.length > 0;
  if (unchanged && slug.length <= maxLength) return slug;
  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${slug.slice(0, Math.max(1, maxLength - 9))}-${hash}`;
}
