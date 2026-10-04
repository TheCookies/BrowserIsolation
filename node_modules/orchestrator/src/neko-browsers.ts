/**
 * Official Neko browser applications (CPU images on GHCR).
 * @see https://neko.m1k1o.net/docs/v3/installation/docker-images
 */

export type BrowserFamily = "firefox" | "chromium";

/** Which of our policy JSON trees to inject (under neko-policies/). */
export type PolicySource = "firefox" | "chrome" | "brave" | null;

export type NekoBrowser = {
  id: string;
  title: string;
  description: string;
  family: BrowserFamily;
  /** GHCR application name: ghcr.io/m1k1o/neko/<image>:<tag> */
  image: string;
  policySource: PolicySource;
  /** Directory that receives policies.json via putArchive; null = skip. */
  policyDir: string | null;
  policyFileName: string;
  profilePath: string;
  /** Filename under /browsers/ (real brand asset from browser-logos / upstream). */
  logo: string;
};

export const NEKO_IMAGE_REGISTRY = "ghcr.io/m1k1o/neko";

export const NEKO_BROWSERS: readonly NekoBrowser[] = [
  {
    id: "firefox",
    title: "Firefox",
    description: "Open-source Gecko browser from Mozilla.",
    family: "firefox",
    image: "firefox",
    policySource: "firefox",
    policyDir: "/usr/lib/firefox/distribution",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.mozilla/firefox/profile.default",
    logo: "firefox.png",
  },
  {
    id: "tor-browser",
    title: "Tor Browser",
    description: "Firefox-based browser for Tor network privacy.",
    family: "firefox",
    image: "tor-browser",
    policySource: "firefox",
    policyDir: "/opt/tor-browser_en-US/Browser/distribution",
    policyFileName: "policies.json",
    profilePath: "/opt/tor-browser_en-US/Browser/TorBrowser/Data/Browser/profile.default",
    logo: "tor-browser.png",
  },
  {
    id: "waterfox",
    title: "Waterfox",
    description: "Privacy-focused Firefox fork.",
    family: "firefox",
    image: "waterfox",
    policySource: "firefox",
    policyDir: "/usr/lib/waterfox/distribution",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.waterfox/profile.default",
    logo: "waterfox.png",
  },
  {
    id: "chromium",
    title: "Chromium",
    description: "Open-source project behind Google Chrome.",
    family: "chromium",
    image: "chromium",
    policySource: "chrome",
    policyDir: "/etc/chromium/policies/managed",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/chromium",
    logo: "chromium.png",
  },
  {
    id: "google-chrome",
    title: "Google Chrome",
    description: "Google's Chromium-based browser.",
    family: "chromium",
    image: "google-chrome",
    policySource: "chrome",
    policyDir: "/etc/opt/chrome/policies/managed",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/google-chrome",
    logo: "google-chrome.png",
  },
  {
    id: "ungoogled-chromium",
    title: "Ungoogled Chromium",
    description: "Chromium without Google integration.",
    family: "chromium",
    image: "ungoogled-chromium",
    policySource: "chrome",
    policyDir: "/etc/chromium/policies/managed",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/chromium",
    logo: "ungoogled-chromium.png",
  },
  {
    id: "microsoft-edge",
    title: "Microsoft Edge",
    description: "Chromium-based Edge browser.",
    family: "chromium",
    image: "microsoft-edge",
    policySource: "chrome",
    policyDir: "/etc/opt/edge/policies/managed",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/microsoft-edge",
    logo: "microsoft-edge.png",
  },
  {
    id: "brave",
    title: "Brave",
    description: "Privacy-focused Chromium browser.",
    family: "chromium",
    image: "brave",
    policySource: "brave",
    policyDir: "/etc/brave/policies/managed",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/brave",
    logo: "brave.png",
  },
  {
    id: "vivaldi",
    title: "Vivaldi",
    description: "Customizable Chromium browser.",
    family: "chromium",
    image: "vivaldi",
    policySource: "chrome",
    policyDir: "/etc/opt/vivaldi/policies/managed",
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/vivaldi",
    logo: "vivaldi.png",
  },
  {
    id: "opera",
    title: "Opera",
    description: "Chromium-based browser (no managed policies).",
    family: "chromium",
    image: "opera",
    policySource: null,
    policyDir: null,
    policyFileName: "policies.json",
    profilePath: "/home/neko/.config/opera",
    logo: "opera.png",
  },
] as const;

export type BrowserType = (typeof NEKO_BROWSERS)[number]["id"];

export const DEFAULT_ENABLED_BROWSERS: BrowserType[] = [
  "google-chrome",
  "firefox",
  "brave",
];

const BY_ID = new Map(NEKO_BROWSERS.map((browser) => [browser.id, browser]));

/** Legacy id used before the full Neko catalog. */
const ALIASES: Record<string, BrowserType> = {
  chrome: "google-chrome",
};

export function normalizeBrowserId(raw: string): BrowserType | null {
  const key = raw.trim().toLowerCase();
  const aliased = ALIASES[key] ?? key;
  return BY_ID.has(aliased) ? (aliased as BrowserType) : null;
}

export function getNekoBrowser(id: string): NekoBrowser | null {
  const normalized = normalizeBrowserId(id);
  return normalized ? (BY_ID.get(normalized) ?? null) : null;
}

export function isBrowserType(value: string): value is BrowserType {
  return normalizeBrowserId(value) !== null;
}

export function parseEnabledBrowsers(raw: string | undefined): BrowserType[] {
  if (raw === undefined || raw.trim() === "") {
    return [...DEFAULT_ENABLED_BROWSERS];
  }
  const seen = new Set<BrowserType>();
  const out: BrowserType[] = [];
  for (const part of raw.split(",")) {
    const id = normalizeBrowserId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) {
    throw new Error("ENABLED_BROWSERS must list at least one supported Neko browser.");
  }
  return out;
}

export function formatEnabledBrowsers(ids: readonly BrowserType[]): string {
  return ids.join(",");
}

export function imageForNekoBrowser(browser: NekoBrowser, tag: string): string {
  const cleanTag = tag.trim() || "latest";
  return `${NEKO_IMAGE_REGISTRY}/${browser.image}:${cleanTag}`;
}

export function assertBrowserEnabled(enabled: readonly BrowserType[], browser: BrowserType): void {
  if (!enabled.includes(browser)) {
    throw Object.assign(new Error("browser_disabled"), { statusCode: 400 });
  }
}
