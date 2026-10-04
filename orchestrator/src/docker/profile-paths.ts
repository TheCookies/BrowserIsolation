import { getNekoBrowser } from "../neko-browsers";
import type { BrowserType } from "../config";

export function profileContainerPath(browser: BrowserType): string {
  const meta = getNekoBrowser(browser);
  if (!meta) throw new Error(`Unknown browser ${browser}`);
  return meta.profilePath;
}
