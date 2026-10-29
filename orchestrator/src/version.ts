import { execFileSync } from "node:child_process";
import type { Config } from "./config";

export const DEFAULT_IMAGE = "ghcr.io/thecookies/browserisolation:latest";
export const REPOSITORY_URL = "https://github.com/TheCookies/BrowserIsolation";

export type AppVersionInfo = {
  version: string;
  gitSha: string;
  gitShaShort: string;
  gitCommitTime: string;
  builtAt: string;
};

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function versionFromParts(shortSha: string, timestamp: string): string {
  const day = (timestamp || new Date().toISOString()).slice(0, 10);
  if (!day || shortSha === "unknown") return "dev";
  return `${day.replace(/-/g, ".")}-${shortSha}`;
}

export function getAppVersion(): AppVersionInfo {
  const sha = process.env.GIT_SHA?.trim() || git(["rev-parse", "HEAD"]) || "unknown";
  const short =
    process.env.GIT_SHA_SHORT?.trim() || (sha !== "unknown" && sha.length >= 7 ? sha.slice(0, 7) : "unknown");
  const gitCommitTime = process.env.GIT_COMMIT_TIME?.trim() || git(["show", "-s", "--format=%cI", "HEAD"]);
  const builtAt = process.env.BUILD_TIME?.trim() || "";
  const version =
    process.env.APP_VERSION?.trim() || versionFromParts(short, gitCommitTime || builtAt);
  return {
    version,
    gitSha: sha,
    gitShaShort: short,
    gitCommitTime,
    builtAt,
  };
}

export type AboutInfo = AppVersionInfo & {
  name: string;
  siteName: string;
  image: string;
  repository: string;
  commitUrl: string | null;
  node: string;
  platform: string;
  role: string;
  publicIp: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  profileDataDir: string;
  persistProfilesEnabled: boolean;
  localWorkerEnabled: boolean;
  browserNetworkMode: string;
  webrtcPortRange: string;
  enabledBrowsers: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
};

export function getAboutInfo(config: Config): AboutInfo {
  const ver = getAppVersion();
  const commitUrl =
    ver.gitSha !== "unknown" ? `${REPOSITORY_URL}/commit/${ver.gitSha}` : null;
  return {
    ...ver,
    name: "Browser Isolation",
    siteName: config.siteName,
    image: process.env.IMAGE?.trim() || DEFAULT_IMAGE,
    repository: REPOSITORY_URL,
    commitUrl,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    role: process.env.RBI_ROLE?.trim() || "orchestrator",
    publicIp: config.publicIp,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    databasePath: config.databasePath,
    profileDataDir: config.profileDataDir || "(named volumes)",
    persistProfilesEnabled: config.persistProfilesEnabled,
    localWorkerEnabled: config.localWorkerEnabled,
    browserNetworkMode: config.browserNetworkMode,
    webrtcPortRange: `${config.webrtcPortStart}-${config.webrtcPortEnd}`,
    enabledBrowsers: [...config.enabledBrowsers],
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
  };
}
