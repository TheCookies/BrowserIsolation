import type { AuthenticatedUser } from "./auth/provider";
import { canAccessBrowserSession } from "./access";
import type { BrowserSessionRecord, BrowserSessionStore } from "./browser-session-store";
import type { BrowserType, Config } from "./config";
import { assertBrowserEnabled, normalizeBrowserId } from "./neko-browsers";
import { createNekoClient, type NekoClient } from "./neko-client";
import { randomToken } from "./security";
import type { UserPreferencesStore } from "./user-preferences";
import type { WorkerPlacement } from "./workers/placement";
import type { ProxyTarget } from "./workers/types";

export type LaunchResult = {
  session: BrowserSessionRecord;
  reconnect: boolean;
};

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type SessionAccess = {
  session: BrowserSessionRecord;
  wsPath: string;
  username: string;
  password: string;
  iceServers: IceServerConfig[];
  allowClipboard: boolean;
  allowDownloads: boolean;
};

export type AdminSessionView = {
  id: string;
  ownerUsername: string;
  browser: BrowserType;
  workerId: string;
  createdAt: number;
  lastActivityAt: number;
  viewers: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
};

export type BrowserSessionService = {
  getMine(username: string): BrowserSessionRecord | null;
  getById(id: string): BrowserSessionRecord | null;
  list(): BrowserSessionRecord[];
  assertAccess(user: AuthenticatedUser, sessionId: string): BrowserSessionRecord;
  resolveProxyTarget(sessionId: string): Promise<{ session: BrowserSessionRecord; proxy: ProxyTarget }>;
  launch(user: AuthenticatedUser, browser: BrowserType): Promise<LaunchResult>;
  destroyForUser(username: string): Promise<boolean>;
  destroyById(sessionId: string): Promise<boolean>;
  issueAccess(user: AuthenticatedUser, sessionId: string): Promise<SessionAccess>;
  listForAdmin(viewerCount: (sessionId: string) => number): Promise<AdminSessionView[]>;
};

function parseIceServers(raw: string): IceServerConfig[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IceServerConfig[]) : [];
  } catch {
    return [];
  }
}

const PROXY_TARGET_TTL_MS = 10_000;

type CachedProxyTarget = {
  proxy: ProxyTarget;
  expiresAt: number;
};

export function createBrowserSessionService(deps: {
  config: Config;
  store: BrowserSessionStore;
  placement: WorkerPlacement;
  neko?: NekoClient;
  preferences: UserPreferencesStore;
}): BrowserSessionService {
  const { config, store, placement, preferences } = deps;
  const neko = deps.neko ?? createNekoClient();
  const proxyTargetCache = new Map<string, CachedProxyTarget>();

  function syncLocalActiveCounts(): void {
    for (const worker of placement.store.list()) {
      const count = store.countByWorker(worker.id);
      placement.store.touchStatus(worker.id, {
        lastSeenAt: worker.kind === "local" ? Date.now() : worker.lastSeenAt ?? Date.now(),
        activeSessions: count,
        publicIp: worker.kind === "local" ? config.publicIp : undefined,
      });
    }
  }

  async function ensureRunning(session: BrowserSessionRecord): Promise<void> {
    const info = await placement.inspect(session.workerId, session.containerId);
    if (!info || !info.running) {
      proxyTargetCache.delete(session.id);
      throw Object.assign(new Error("session_unavailable"), { statusCode: 503 });
    }
  }

  function cacheProxyTarget(sessionId: string, proxy: ProxyTarget): void {
    proxyTargetCache.set(sessionId, {
      proxy,
      expiresAt: Date.now() + PROXY_TARGET_TTL_MS,
    });
  }

  async function destroyRecord(session: BrowserSessionRecord): Promise<void> {
    proxyTargetCache.delete(session.id);
    try {
      await placement.remove(session.workerId, session.containerId);
    } finally {
      store.delete(session.id);
      syncLocalActiveCounts();
    }
  }

  return {
    getMine(username) {
      return store.getByOwner(username);
    },

    getById(id) {
      return store.getById(id);
    },

    list() {
      return store.list();
    },

    assertAccess(user, sessionId) {
      const session = store.getById(sessionId);
      if (!session) {
        throw Object.assign(new Error("not_found"), { statusCode: 404 });
      }
      if (!canAccessBrowserSession(user, session)) {
        throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      }
      return session;
    },

    async resolveProxyTarget(sessionId) {
      const session = store.getById(sessionId);
      if (!session) {
        proxyTargetCache.delete(sessionId);
        throw Object.assign(new Error("not_found"), { statusCode: 404 });
      }

      const cached = proxyTargetCache.get(sessionId);
      if (cached && cached.expiresAt > Date.now()) {
        store.touch(session.id);
        return { session, proxy: cached.proxy };
      }

      await ensureRunning(session);
      const proxy = placement.proxyTarget(
        session.workerId,
        session.containerId,
        session.containerName,
      );
      cacheProxyTarget(sessionId, proxy);
      store.touch(session.id);
      return { session, proxy };
    },

    async launch(user, browser) {
      const normalized = normalizeBrowserId(browser);
      if (!normalized) {
        throw Object.assign(new Error("invalid_browser"), { statusCode: 400 });
      }
      assertBrowserEnabled(config.enabledBrowsers, normalized);

      const existing = store.getByOwner(user.username);
      if (existing) {
        try {
          await ensureRunning(existing);
          store.touch(existing.id);
          return { session: existing, reconnect: true };
        } catch {
          await destroyRecord(existing);
        }
      }

      syncLocalActiveCounts();
      const persistProfile =
        config.persistProfilesEnabled && preferences.get(user.subjectId).persistProfile;
      const worker = placement.pickForLaunch({
        persistProfile,
        subjectId: user.subjectId,
        browser: normalized,
      });

      const sessionId = randomToken();
      const nekoAdminPassword = randomToken();
      const nekoUserPassword = randomToken();
      const now = Date.now();

      try {
        const created = await placement.createBrowser(worker, {
          sessionId,
          owner: user.username,
          subjectId: user.subjectId,
          browser: normalized,
          nekoAdminPassword,
          nekoUserPassword,
          persistProfile,
        });

        // Local containers are reached over the Docker network; wait for readiness here.
        // Remote workers already wait inside the agent before returning.
        if (worker.kind === "local") {
          const host = created.ipAddress || created.containerName;
          if (!host) throw new Error("container_missing_host");
          try {
            await neko.waitUntilReady(`http://${host}:8080`);
          } catch (readyError) {
            const logs = await placement.logs(worker.id, created.containerId).catch(() => "");
            const detail = readyError instanceof Error ? readyError.message : String(readyError);
            await placement.remove(worker.id, created.containerId).catch(() => undefined);
            throw new Error(logs ? `${detail} | logs: ${logs}` : detail);
          }
        }

        const record: BrowserSessionRecord = {
          id: sessionId,
          ownerUsername: user.username,
          browser: normalized,
          containerId: created.containerId,
          containerName: created.containerName,
          nekoAdminPassword,
          nekoUserPassword,
          webrtcPort: created.webrtcPort,
          workerId: created.workerId,
          createdAt: now,
          lastActivityAt: now,
        };
        store.insert(record);
        syncLocalActiveCounts();
        return { session: record, reconnect: false };
      } catch (error) {
        syncLocalActiveCounts();
        throw error;
      }
    },

    async destroyForUser(username) {
      const existing = store.getByOwner(username);
      if (!existing) return false;
      await destroyRecord(existing);
      return true;
    },

    async destroyById(sessionId) {
      const existing = store.getById(sessionId);
      if (!existing) return false;
      await destroyRecord(existing);
      return true;
    },

    async issueAccess(user, sessionId) {
      const session = this.assertAccess(user, sessionId);
      await ensureRunning(session);
      store.touch(session.id);
      return {
        session,
        wsPath: `/session/${session.id}/view/ws`,
        username: "rbi",
        password: session.nekoAdminPassword,
        iceServers: parseIceServers(config.iceServersFrontend),
        allowClipboard: config.allowClipboard,
        allowDownloads: config.allowDownloads,
      };
    },

    async listForAdmin(viewerCount) {
      const sessions = store.list();
      const views: AdminSessionView[] = [];
      for (const session of sessions) {
        let cpuPercent: number | null = null;
        let memoryBytes: number | null = null;
        try {
          const stats = await placement.stats(session.workerId, session.containerId);
          cpuPercent = stats.cpuPercent;
          memoryBytes = stats.memoryBytes;
        } catch {
          /* stats are best-effort */
        }
        views.push({
          id: session.id,
          ownerUsername: session.ownerUsername,
          browser: session.browser,
          workerId: session.workerId,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt,
          viewers: viewerCount(session.id),
          cpuPercent,
          memoryBytes,
        });
      }
      return views;
    },
  };
}
