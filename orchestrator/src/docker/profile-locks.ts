import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Browser lock / singleton files left behind when a container is force-killed.
 * Remounting them makes Firefox show “already running but is not responding”
 * (black Neko desktop) and can stall Chromium similarly.
 */
export const PROFILE_LOCK_BASENAMES = [
  ".parentlock",
  "lock",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
] as const;

export type ClearedProfileLock = {
  path: string;
  name: string;
};

function isLockName(name: string): boolean {
  return (PROFILE_LOCK_BASENAMES as readonly string[]).includes(name);
}

/**
 * Remove stale browser lock files under a host profile directory.
 * Safe no-op when the directory does not exist yet.
 */
export function clearProfileLockFiles(profileDir: string): ClearedProfileLock[] {
  if (!profileDir || !existsSync(profileDir)) return [];

  const cleared: ClearedProfileLock[] = [];
  const queue = [profileDir];
  const maxDirs = 64;
  let seen = 0;

  while (queue.length > 0 && seen < maxDirs) {
    const dir = queue.shift()!;
    seen += 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = lstatSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Chromium sometimes nests Default/; Firefox locks sit at profile root.
        // Walk one level of subdirs only (seen budget caps depth/breadth).
        if (seen < maxDirs) queue.push(full);
        continue;
      }
      if (!isLockName(name)) continue;
      try {
        rmSync(full, { force: true });
        cleared.push({ path: full, name });
      } catch {
        /* best-effort — start may still fail if unreadable */
      }
    }
  }

  return cleared;
}
