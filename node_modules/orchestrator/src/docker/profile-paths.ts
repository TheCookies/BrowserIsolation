import path from "node:path";
import { parseProfileVolumeName, profileStorageKey } from "../auth/identity";
import { getNekoBrowser } from "../neko-browsers";
import type { BrowserType } from "../config";

export function profileContainerPath(browser: BrowserType): string {
  const meta = getNekoBrowser(browser);
  if (!meta) throw new Error(`Unknown browser ${browser}`);
  return meta.profilePath;
}

/** Host directory for a persistent profile when PROFILE_DATA_DIR is set. */
export function profileHostDir(
  profileDataDir: string,
  subjectId: string,
  browser: string,
): string {
  return path.join(profileDataDir, profileStorageKey(subjectId), browser);
}

export function profileHostDirFromVolumeName(
  profileDataDir: string,
  volumeName: string,
): string | null {
  const parsed = parseProfileVolumeName(volumeName);
  if (!parsed) return null;
  return path.join(profileDataDir, parsed.subjectKey, parsed.browser);
}
