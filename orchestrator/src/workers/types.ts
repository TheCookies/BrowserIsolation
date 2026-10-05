import type { BrowserType } from "../config";

/** Live browser launch settings snapped from the orchestrator config. */
export type BrowserLaunchSettings = {
  nekoImageTag: string;
  browserShmSizeBytes: number;
  browserNanoCpus: number;
  browserMemoryBytes: number;
  webrtcIceLite: boolean;
  iceServersFrontend: string;
  iceServersBackend: string;
  desktopScreen: string;
  captureVideoCodec: "vp8" | "h264";
  allowClipboard: boolean;
  allowDownloads: boolean;
};

export type WorkerCreateBrowserRequest = {
  sessionId: string;
  owner: string;
  subjectId: string;
  browser: BrowserType;
  nekoAdminPassword: string;
  nekoUserPassword: string;
  persistProfile: boolean;
  settings: BrowserLaunchSettings;
};

export type WorkerCreateBrowserResponse = {
  containerId: string;
  containerName: string;
  webrtcPort: number;
  publicIp: string;
  ipAddress: string | null;
  /** Local HTTP/WS origin for readiness + proxy (e.g. http://127.0.0.1:xxxxx). */
  proxyOrigin?: string | null;
};

export type WorkerStatusResponse = {
  id: string;
  publicIp: string;
  webrtcPortStart: number;
  webrtcPortEnd: number;
  activeSessions: number;
  ok: boolean;
};

export type WorkerRecord = {
  id: string;
  /** Empty for the embedded local worker. */
  baseUrl: string;
  publicIp: string;
  /** Empty for the embedded local worker. */
  token: string;
  enabled: boolean;
  kind: "local" | "remote";
  lastSeenAt: number | null;
  activeSessions: number;
};

export type ProxyTarget = {
  targetOrigin: string;
  /** Extra headers for the upstream proxy (e.g. worker Bearer token). */
  headers?: Record<string, string>;
};
