import type Database from "better-sqlite3";
import { createAuditStore, defaultAuditEnabledActions } from "../src/audit-store";
import { createBrandingStore } from "../src/branding-store";
import { createLocalUserStore } from "../src/auth/local-user-store";
import type { BrowserSessionRecord } from "../src/browser-session-store";
import type { BrowserSessionService } from "../src/browser-sessions";
import type { Config } from "../src/config";
import type { ContainerRuntime } from "../src/docker/container-runtime";
import { DEFAULT_ENABLED_BROWSERS } from "../src/neko-browsers";
import { createPortPool } from "../src/port-pool";
import { createSettingsStore } from "../src/settings-store";
import { createViewerTracker } from "../src/viewer-tracker";
import { createWorkerPlacement } from "../src/workers/placement";
import { createWorkerStore } from "../src/workers/store";

export function testConfig(partial?: Partial<Config>): Config {
  return {
    host: "127.0.0.1",
    port: 8080,
    siteName: "Browser Isolation",
    trustProxy: false,
    cookieSecure: false,
    cookieName: "rbi_session",
    csrfCookieName: "rbi_csrf",
    sessionTtlMs: 24 * 60 * 60 * 1000,
    databasePath: "/tmp/rbi-test.sqlite",
    staticDir: null,
    authUsers: "admin:admin:admin,user:user:user",
    bcryptRounds: 4,
    enabledBrowsers: [...DEFAULT_ENABLED_BROWSERS],
    nekoImageTag: "latest",
    browserNetwork: "rbi-browsers",
    browserNetworkMode: "bridge",
    browserShmSizeBytes: 2 * 1024 ** 3,
    browserNanoCpus: 3e9,
    browserMemoryBytes: 2 * 1024 ** 3,
    publicIp: "127.0.0.1",
    webrtcPortStart: 52000,
    webrtcPortEnd: 52099,
    webrtcIceLite: true,
    iceServersFrontend: "[]",
    iceServersBackend: "[]",
    desktopScreen: "1280x720@30",
    captureVideoCodec: "h264",
    dockerSocketPath: "/var/run/docker.sock",
    nekoPoliciesDir: "/tmp/neko-policies-unused",
    persistProfilesEnabled: true,
    profileDataDir: "",
    allowClipboard: false,
    allowDownloads: false,
    idleTimeoutMinutes: 60,
    maxSessionHours: 12,
    reaperIntervalSeconds: 60,
    localWorkerEnabled: true,
    workersBootstrap: "",
    workerEnrollToken: "",
    publicBaseUrl: "",
    samlEnabled: false,
    samlEntryPoint: "",
    samlIdpEntityId: "",
    samlIdpCert: "",
    samlSpEntityId: "",
    samlUsernameAttr: "",
    samlGroupsAttr: "",
    samlAdminGroup: "",
    auditEnabledActions: defaultAuditEnabledActions(),
    ...partial,
  };
}

export function stubRuntime(overrides?: Partial<ContainerRuntime>): ContainerRuntime {
  const base: ContainerRuntime = {
    async ensureNetwork() {},
    async createBrowserContainer() {
      throw new Error("not_implemented");
    },
    async inspect() {
      return null;
    },
    async stats() {
      return { cpuPercent: null, memoryBytes: null };
    },
    async logs() {
      return "";
    },
    async remove() {},
    async listManaged() {
      return [];
    },
    async listProfileVolumes() {
      return [];
    },
    async removeProfileVolume() {},
    async pullImages(images) {
      return images.map((image) => ({ image, ok: true }));
    },
    async removeImages(images) {
      return images.map((image) => ({ image, ok: true }));
    },
  };
  return { ...base, ...overrides };
}

export function testPlacement(db: Database.Database, config: Config, runtime?: ContainerRuntime) {
  const workerStore = createWorkerStore(db);
  workerStore.upsert({
    id: "local",
    baseUrl: "",
    publicIp: config.publicIp,
    token: "",
    enabled: true,
    kind: "local",
    lastSeenAt: Date.now(),
    activeSessions: 0,
  });
  const localRuntime = runtime ?? stubRuntime();
  const localPorts = createPortPool(db, config.webrtcPortStart, config.webrtcPortEnd);
  return {
    workerStore,
    placement: createWorkerPlacement({
      config,
      store: workerStore,
      localRuntime,
      localPorts,
    }),
    localRuntime,
    localPorts,
  };
}

export function testSideChannels(db: Database.Database, config?: Config) {
  const cfg = config ?? testConfig({ databasePath: ":memory:" });
  const runtime = stubRuntime();
  const { placement, workerStore } = config
    ? testPlacement(db, config, runtime)
    : {
        placement: createWorkerPlacement({
          config: cfg,
          store: createWorkerStore(db),
          localRuntime: runtime,
          localPorts: createPortPool(db, cfg.webrtcPortStart, cfg.webrtcPortEnd),
        }),
        workerStore: createWorkerStore(db),
      };
  if (!config) {
    workerStore.upsert({
      id: "local",
      baseUrl: "",
      publicIp: "127.0.0.1",
      token: "",
      enabled: true,
      kind: "local",
    });
  }
  return {
    audit: createAuditStore(db, {
      isEnabled: (action) => cfg.auditEnabledActions.includes(action),
    }),
    viewers: createViewerTracker(),
    settings: config
      ? createSettingsStore(db, config)
      : {
          list() {
            return { editable: [], readonly: [] };
          },
          update() {
            return { updated: [] };
          },
          setEnabledBrowsers(ids: string[]) {
            return { enabled: ids };
          },
          hydrateConfig() {},
        },
    localUsers: createLocalUserStore(db),
    branding: createBrandingStore(cfg.databasePath),
    runtime,
    placement,
    workerStore,
  };
}

/** No-op browser service for auth/static tests that do not exercise containers. */
export function stubBrowsers(overrides?: Partial<BrowserSessionService>): BrowserSessionService {
  const base: BrowserSessionService = {
    getMine() {
      return null;
    },
    getById() {
      return null;
    },
    list() {
      return [];
    },
    assertAccess() {
      throw Object.assign(new Error("not_found"), { statusCode: 404 });
    },
    async resolveProxyTarget() {
      throw Object.assign(new Error("not_found"), { statusCode: 404 });
    },
    async launch() {
      throw new Error("not_implemented");
    },
    async destroyForUser() {
      return false;
    },
    async destroyById() {
      return false;
    },
    async issueAccess() {
      throw Object.assign(new Error("not_found"), { statusCode: 404 });
    },
    async listForAdmin() {
      return [];
    },
  };
  return { ...base, ...overrides };
}

export function sampleSession(partial?: Partial<BrowserSessionRecord>): BrowserSessionRecord {
  const now = Date.now();
  return {
    id: partial?.id ?? "session-a",
    ownerUsername: partial?.ownerUsername ?? "gus",
    browser: partial?.browser ?? "google-chrome",
    containerId: partial?.containerId ?? "container-a",
    containerName: partial?.containerName ?? "rbi-session-a",
    nekoAdminPassword: partial?.nekoAdminPassword ?? "admin-secret",
    nekoUserPassword: partial?.nekoUserPassword ?? "user-secret",
    webrtcPort: partial?.webrtcPort ?? 52000,
    workerId: partial?.workerId ?? "local",
    createdAt: partial?.createdAt ?? now,
    lastActivityAt: partial?.lastActivityAt ?? now,
  };
}
