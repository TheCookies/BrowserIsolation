import type { AuthenticatedUser } from "./auth/provider";
import { canAccessBrowserSession } from "./access";
import type { BrowserSessionRecord, BrowserSessionStore } from "./browser-session-store";
import type { BrowserType, Config } from "./config";
import { assertBrowserEnabled, normalizeBrowserId } from "./neko-browsers";
import { createNekoClient, type NekoClient } from "./neko-client";
import { randomToken } from "./security";
import type { UserPreferencesStore } from "./user-preferences";
import type { WorkerPlacement } from "./workers/placement";
import { isWorkerOnline } from "./workers/scheduler";
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
  getMine(user: Pick<AuthenticatedUser, "username" | "subjectId">): BrowserSessionRecord | null;
  getById(id: string): BrowserSessionRecord | null;
  list(): BrowserSessionRecord[];
  assertAccess(user: AuthenticatedUser, sessionId: string): BrowserSessionRecord;
  resolveProxyTarget(sessionId: string): Promise<{ session: BrowserSessionRecord; proxy: ProxyTarget }>;
  launch(user: AuthenticatedUser, browser: BrowserType): Promise<LaunchResult>;
  destroyForUser(user: Pick<AuthenticatedUser, "username" | "subjectId">): Promise<boolean>;
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

/**
 * Same-user launches share one queue so a second click waits and reconnects.
 * Different users (including simultaneous LDAP logins) stay parallel.
 */
function enqueueLaunch<T>(chains: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.finally(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

/** Worker is down or rejected the token — stop sending it new launches. */
function isWorkerTransportFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message === "unauthorized" || message === "worker_auth_failed") return true;
  return (
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("fetch failed") ||
    /^worker_http_(401|502|503|504)$/.test(message)
  );
}

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
  const launchChains = new Map<string, Promise<void>>();

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
    const worker = placement.getWorker(session.workerId);
    if (!worker || !isWorkerOnline(worker)) {
      proxyTargetCache.delete(session.id);
      throw Object.assign(new Error("session_unavailable"), { statusCode: 503 });
    }
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
    const worker = placement.getWorker(session.workerId);
    // Only contact the worker while it looks reachable. Offline/disabled workers are
    // abandoned so launch can proceed on another host; orphans are reconciled later.
    if (worker && isWorkerOnline(worker)) {
      try {
        await placement.remove(session.workerId, session.containerId);
      } catch {
        /* ignore unreachable / unauthorized workers during teardown */
      }
    }
    store.delete(session.id);
    syncLocalActiveCounts();
  }

  function findOwnedSession(
    user: Pick<AuthenticatedUser, "username" | "subjectId">,
  ): BrowserSessionRecord | null {
    // Prefer subjectId so LDAP users reconnect even when display username varies
    // (sAMAccountName vs UPN). Only fall back to username for a legacy row that
    // has no subject, or the same subject. A shared display name must not hand
    // one LDAP user another person's browser.
    const bySubject = store.getBySubjectId(user.subjectId);
    if (bySubject) return bySubject;
    const byName = store.getByOwner(user.username);
    if (!byName) return null;
    if (byName.ownerSubjectId && user.subjectId && byName.ownerSubjectId !== user.subjectId) {
      return null;
    }
    return byName;
  }

  async function launchOne(
    user: AuthenticatedUser,
    browser: BrowserType,
  ): Promise<LaunchResult> {
    const normalized = normalizeBrowserId(browser);
    if (!normalized) {
      throw Object.assign(new Error("invalid_browser"), { statusCode: 400 });
    }
    assertBrowserEnabled(config.enabledBrowsers, normalized);

    const existing = findOwnedSession(user);
    if (existing) {
      try {
        await ensureRunning(existing);
        store.touch(existing.id);
        return { session: existing, reconnect: true };
      } catch {
        await destroyRecord(existing);
      }
    }

    const persistProfile =
      config.persistProfilesEnabled && preferences.get(user.subjectId).persistProfile;
    const excluded = new Set<string>();
    let lastError: unknown;

    for (;;) {
      syncLocalActiveCounts();
      let worker;
      try {
        worker = placement.pickForLaunch({
          persistProfile,
          subjectId: user.subjectId,
          browser: normalized,
          excludeWorkerIds: excluded,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // One live probe before giving up — covers "just authorized" and brief blips.
        if (message === "no_workers_available" && excluded.size === 0) {
          const online = await placement.refreshOnlineWorkers();
          if (online > 0) {
            try {
              worker = placement.pickForLaunch({
                persistProfile,
                subjectId: user.subjectId,
                browser: normalized,
                excludeWorkerIds: excluded,
              });
            } catch (retryError) {
              if (lastError !== undefined) throw lastError;
              throw retryError;
            }
          } else {
            if (lastError !== undefined) throw lastError;
            throw error;
          }
        } else {
          if (lastError !== undefined) throw lastError;
          throw error;
        }
      }

      const sessionId = randomToken();
      const nekoAdminPassword = randomToken();
      const nekoUserPassword = randomToken();
      const now = Date.now();

      let createdContainerId: string | null = null;
      // Local ports are reserved at allocate() and must stay reserved until the
      // session row exists. Releasing earlier lets a concurrent launch reuse it.
      let heldLocalPort: number | null = null;
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
        createdContainerId = created.containerId;
        if (worker.kind === "local") heldLocalPort = created.webrtcPort;

        // Local containers are reached over the Docker network; wait for readiness here.
        // Remote workers already wait inside the agent before returning.
        if (worker.kind === "local") {
          const readyUrl =
            created.proxyOrigin ||
            (created.ipAddress ? `http://${created.ipAddress}:8080` : null);
          if (!readyUrl) throw new Error("container_missing_host");
          try {
            await neko.waitUntilReady(readyUrl);
          } catch (readyError) {
            const logs = await placement.logs(worker.id, created.containerId).catch(() => "");
            const detail = readyError instanceof Error ? readyError.message : String(readyError);
            await placement.remove(worker.id, created.containerId).catch(() => undefined);
            createdContainerId = null;
            throw new Error(logs ? `${detail} | logs: ${logs}` : detail);
          }
        }

        const record: BrowserSessionRecord = {
          id: sessionId,
          ownerUsername: user.username,
          ownerSubjectId: user.subjectId,
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
        if (heldLocalPort !== null) {
          placement.releaseLocalPort(heldLocalPort);
          heldLocalPort = null;
        }
        syncLocalActiveCounts();
        return { session: record, reconnect: false };
      } catch (error) {
        if (heldLocalPort !== null) {
          placement.releaseLocalPort(heldLocalPort);
          heldLocalPort = null;
        }
        if (createdContainerId) {
          await placement.remove(worker.id, createdContainerId).catch(() => undefined);
        }
        syncLocalActiveCounts();
        excluded.add(worker.id);
        const message = error instanceof Error ? error.message : String(error);
        lastError =
          message === "unauthorized"
            ? Object.assign(new Error("worker_auth_failed"), { statusCode: 502 })
            : error;
        // A container error on one user must not take the host offline for everyone else.
        if (worker.kind === "remote" && isWorkerTransportFailure(error)) {
          placement.store.markUnseen(worker.id);
        }
        if (persistProfile) {
          placement.store.clearProfilePlacement(user.subjectId, normalized);
        }
      }
    }
  }

  return {
    getMine(user) {
      return findOwnedSession(user);
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
      const proxy = await placement.proxyTarget(
        session.workerId,
        session.containerId,
        session.containerName,
      );
      cacheProxyTarget(sessionId, proxy);
      store.touch(session.id);
      return { session, proxy };
    },

    launch(user, browser) {
      // Queue per subject so one person cannot start two containers, while
      // other LDAP users still launch at the same time.
      return enqueueLaunch(launchChains, user.subjectId, () => launchOne(user, browser));
    },

    async destroyForUser(user) {
      const existing = findOwnedSession(user);
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
