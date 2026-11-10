import { chmodSync, chownSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** UID/GID of the `neko` user inside m1k1o/neko browser images. */
export const NEKO_HOST_UID = 1000;
export const NEKO_HOST_GID = 1000;

function chownRecursive(dir: string, uid: number, gid: number): void {
  chownSync(dir, uid, gid);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) chownRecursive(full, uid, gid);
      else chownSync(full, uid, gid);
    } catch {
      /* best-effort on individual entries */
    }
  }
}

/**
 * Create a host bind-mount profile directory that the Neko browser user can write.
 * Without this, root-owned dirs stay empty (0B) and Firefox shows
 * “already running but is not responding” when it cannot update lock files.
 */
export function ensureWritableProfileHostDir(hostDir: string): void {
  mkdirSync(hostDir, { recursive: true });

  // Ensure the subject parent exists with usable mode too.
  const subjectDir = path.dirname(hostDir);
  try {
    chmodSync(subjectDir, 0o755);
  } catch {
    /* ignore */
  }
  try {
    chmodSync(hostDir, 0o755);
  } catch {
    /* ignore */
  }

  if (process.platform === "win32") return;

  try {
    chownSync(subjectDir, NEKO_HOST_UID, NEKO_HOST_GID);
    chownRecursive(hostDir, NEKO_HOST_UID, NEKO_HOST_GID);
  } catch {
    // Orchestrator without CAP_CHOWN: fall back so the container can still write.
    try {
      chmodSync(hostDir, 0o777);
    } catch {
      /* ignore */
    }
  }
}

/** True when the directory is missing or not owned by the Neko UID (Linux). */
export function profileHostDirNeedsFix(hostDir: string): boolean {
  try {
    const st = statSync(hostDir);
    if (process.platform === "win32") return false;
    return st.uid !== NEKO_HOST_UID;
  } catch {
    return true;
  }
}
