import type { Config } from "../config";
import type {
  BrowserContainerInfo,
  ContainerRuntime,
  ContainerStats,
  ImagePullProgressHandler,
  ImagePullResult,
  ImageRemoveResult,
} from "../docker/container-runtime";
import type { PortPool } from "../port-pool";
import { createRemoteWorkerClient } from "./client";
import { pickWorker } from "./scheduler";
import type { WorkerStore } from "./store";
import type {
  BrowserLaunchSettings,
  ProxyTarget,
  WorkerCreateBrowserRequest,
  WorkerCreateBrowserResponse,
  WorkerRecord,
} from "./types";

export type PlacementCreateResult = WorkerCreateBrowserResponse & {
  workerId: string;
};

export type WorkerPlacement = {
  pickForLaunch(input: {
    persistProfile: boolean;
    subjectId: string;
    browser: string;
    excludeWorkerIds?: ReadonlySet<string>;
  }): WorkerRecord;
  /** Ping enabled remote workers and refresh online heartbeats. */
  refreshOnlineWorkers(): Promise<number>;
  createBrowser(
    worker: WorkerRecord,
    request: Omit<WorkerCreateBrowserRequest, "settings">,
  ): Promise<PlacementCreateResult>;
  remove(workerId: string, containerId: string): Promise<void>;
  inspect(workerId: string, containerId: string): Promise<BrowserContainerInfo | null>;
  stats(workerId: string, containerId: string): Promise<ContainerStats>;
  logs(workerId: string, containerId: string, tail?: number): Promise<string>;
  listManagedOn(workerId: string): Promise<BrowserContainerInfo[]>;
  listManagedAll(): Promise<Array<BrowserContainerInfo & { workerId: string }>>;
  pullImages(
    images: string[],
    onProgress?: ImagePullProgressHandler,
  ): Promise<Array<ImagePullResult & { workerId: string }>>;
  removeImages(images: string[]): Promise<Array<ImageRemoveResult & { workerId: string }>>;
  proxyTarget(
    workerId: string,
    containerId: string,
    containerName: string,
  ): Promise<ProxyTarget>;
  refreshLocalActiveSessions(): void;
  getWorker(id: string): WorkerRecord | null;
  store: WorkerStore;
};

function launchSettings(config: Config): BrowserLaunchSettings {
  return {
    nekoImageTag: config.nekoImageTag,
    browserShmSizeBytes: config.browserShmSizeBytes,
    browserNanoCpus: config.browserNanoCpus,
    browserMemoryBytes: config.browserMemoryBytes,
    webrtcIceLite: config.webrtcIceLite,
    iceServersFrontend: config.iceServersFrontend,
    iceServersBackend: config.iceServersBackend,
    desktopScreen: config.desktopScreen,
    captureVideoCodec: config.captureVideoCodec,
    allowClipboard: config.allowClipboard,
    allowDownloads: config.allowDownloads,
  };
}

export function createWorkerPlacement(deps: {
  config: Config;
  store: WorkerStore;
  localRuntime: ContainerRuntime;
  localPorts: PortPool;
}): WorkerPlacement {
  const { config, store, localRuntime, localPorts } = deps;

  function requireWorker(id: string): WorkerRecord {
    const worker = store.get(id);
    if (!worker) {
      throw Object.assign(new Error(`unknown_worker:${id}`), { statusCode: 500 });
    }
    return worker;
  }

  /** Prefer the shared enroll secret so SQLite never drifts from worker .env tokens. */
  function agentToken(worker: WorkerRecord): string {
    if (config.workerEnrollToken) {
      if (worker.kind === "remote" && worker.token !== config.workerEnrollToken) {
        store.upsert({
          id: worker.id,
          baseUrl: worker.baseUrl,
          publicIp: worker.publicIp,
          token: config.workerEnrollToken,
          enabled: worker.enabled,
          kind: worker.kind,
          lastSeenAt: worker.lastSeenAt,
          activeSessions: worker.activeSessions,
        });
      }
      return config.workerEnrollToken;
    }
    return worker.token;
  }

  function remote(worker: WorkerRecord) {
    return createRemoteWorkerClient({ baseUrl: worker.baseUrl, token: agentToken(worker) });
  }

  return {
    store,

    getWorker(id) {
      return store.get(id);
    },

    refreshLocalActiveSessions() {
      const local = store.get("local");
      if (!local) return;
      // Count sessions is done by caller via touch; keep last poll value for remotes.
    },

    pickForLaunch(input) {
      const sticky =
        input.persistProfile
          ? store.getProfilePlacement(input.subjectId, input.browser)
          : null;
      const exclude = input.excludeWorkerIds;
      const workers = exclude?.size
        ? store.list().filter((worker) => !exclude.has(worker.id))
        : store.list();
      // Refresh local active count from SQLite-backed sessions is handled externally;
      // use stored activeSessions for remotes and for local.
      const picked = pickWorker(workers, { stickyWorkerId: sticky });
      if (!picked) {
        throw Object.assign(new Error("no_workers_available"), { statusCode: 503 });
      }
      return picked;
    },

    async refreshOnlineWorkers() {
      let online = 0;
      for (const worker of store.list()) {
        if (!worker.enabled) continue;
        if (worker.kind === "local") {
          store.touchStatus(worker.id, {
            lastSeenAt: Date.now(),
            activeSessions: worker.activeSessions,
            publicIp: config.publicIp,
          });
          online += 1;
          continue;
        }
        try {
          const status = await remote(worker).status();
          store.touchStatus(worker.id, {
            lastSeenAt: Date.now(),
            activeSessions: status.activeSessions,
            publicIp: status.publicIp || worker.publicIp,
          });
          online += 1;
        } catch {
          store.markUnseen(worker.id);
        }
      }
      return online;
    },

    async createBrowser(worker, request) {
      const settings = launchSettings(config);
      const full: WorkerCreateBrowserRequest = { ...request, settings };

      if (worker.kind === "local") {
        const webrtcPort = localPorts.allocate();
        let containerId = "";
        try {
          const created = await localRuntime.createBrowserContainer({
            sessionId: full.sessionId,
            owner: full.owner,
            subjectId: full.subjectId,
            browser: full.browser,
            webrtcPort,
            nekoAdminPassword: full.nekoAdminPassword,
            nekoUserPassword: full.nekoUserPassword,
            persistProfile: full.persistProfile,
            settings,
          });
          containerId = created.id;
          const result: PlacementCreateResult = {
            workerId: worker.id,
            containerId: created.id,
            containerName: created.name,
            webrtcPort,
            publicIp: config.publicIp,
            ipAddress: created.ipAddress,
            proxyOrigin: created.proxyOrigin,
          };
          if (full.persistProfile) {
            store.setProfilePlacement(full.subjectId, full.browser, worker.id);
          }
          store.touchStatus(worker.id, {
            lastSeenAt: Date.now(),
            activeSessions: worker.activeSessions + 1,
            publicIp: config.publicIp,
          });
          return result;
        } catch (error) {
          if (containerId) await localRuntime.remove(containerId).catch(() => undefined);
          localPorts.release(webrtcPort);
          throw error;
        }
      }

      const created = await remote(worker).createBrowser(full);
      if (full.persistProfile) {
        store.setProfilePlacement(full.subjectId, full.browser, worker.id);
      }
      store.touchStatus(worker.id, {
        lastSeenAt: Date.now(),
        activeSessions: Math.max(0, worker.activeSessions) + 1,
        publicIp: created.publicIp || worker.publicIp,
      });
      return { ...created, workerId: worker.id };
    },

    async remove(workerId, containerId) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") {
        await localRuntime.remove(containerId);
      } else {
        await remote(worker).remove(containerId);
      }
      const latest = store.get(workerId);
      if (latest) {
        store.touchStatus(workerId, {
          lastSeenAt: Date.now(),
          activeSessions: Math.max(0, latest.activeSessions - 1),
        });
      }
    },

    async inspect(workerId, containerId) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") return localRuntime.inspect(containerId);
      return remote(worker).inspect(containerId);
    },

    async stats(workerId, containerId) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") return localRuntime.stats(containerId);
      return remote(worker).stats(containerId);
    },

    async logs(workerId, containerId, tail) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") return localRuntime.logs(containerId, tail);
      return remote(worker).logs(containerId, tail);
    },

    async listManagedOn(workerId) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") return localRuntime.listManaged();
      return remote(worker).listManaged();
    },

    async listManagedAll() {
      const out: Array<BrowserContainerInfo & { workerId: string }> = [];
      for (const worker of store.list()) {
        if (!worker.enabled) continue;
        try {
          const list = await this.listManagedOn(worker.id);
          for (const item of list) out.push({ ...item, workerId: worker.id });
        } catch {
          /* skip unreachable workers during reconcile */
        }
      }
      return out;
    },

    async pullImages(images, onProgress) {
      const results: Array<ImagePullResult & { workerId: string }> = [];
      for (const worker of store.list()) {
        if (!worker.enabled) continue;
        try {
          if (worker.kind === "local") {
            const pulled = await localRuntime.pullImages(images, (event) => {
              onProgress?.({
                ...event,
                detail: event.detail
                  ? `[${worker.id}] ${event.detail}`
                  : `[${worker.id}] ${event.status}`,
              });
            });
            for (const item of pulled) results.push({ ...item, workerId: worker.id });
          } else {
            for (const image of images) {
              onProgress?.({
                image,
                status: "Pulling",
                detail: `[${worker.id}] Requesting pull on remote worker…`,
              });
            }
            const pulled = await remote(worker).pullImages(images);
            for (const item of pulled) {
              onProgress?.({
                image: item.image,
                status: item.ok ? "complete" : "error",
                percent: item.ok ? 100 : undefined,
                detail: item.ok
                  ? `[${worker.id}] Pull complete`
                  : `[${worker.id}] ${item.error ?? "pull failed"}`,
              });
              results.push({ ...item, workerId: worker.id });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const image of images) {
            onProgress?.({
              image,
              status: "error",
              detail: `[${worker.id}] ${message}`,
            });
            results.push({
              image,
              ok: false,
              error: message,
              workerId: worker.id,
            });
          }
        }
      }
      return results;
    },

    async removeImages(images) {
      const results: Array<ImageRemoveResult & { workerId: string }> = [];
      for (const worker of store.list()) {
        if (!worker.enabled) continue;
        try {
          if (worker.kind === "local") {
            const removed = await localRuntime.removeImages(images);
            for (const item of removed) results.push({ ...item, workerId: worker.id });
          } else {
            const removed = await remote(worker).removeImages(images);
            for (const item of removed) results.push({ ...item, workerId: worker.id });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const image of images) {
            results.push({
              image,
              ok: false,
              error: message,
              workerId: worker.id,
            });
          }
        }
      }
      return results;
    },

    async proxyTarget(workerId, containerId, _containerName) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") {
        // Prefer loopback-published Neko port (Podman --network=host orchestrator).
        // Fall back to bridge IP. Never use container DNS names here.
        const info = await localRuntime.inspect(containerId);
        const origin =
          info?.proxyOrigin || (info?.ipAddress ? `http://${info.ipAddress}:8080` : null);
        if (!origin) {
          throw Object.assign(new Error("container_missing_ip"), { statusCode: 502 });
        }
        return { targetOrigin: origin };
      }
      const client = remote(worker);
      return {
        targetOrigin: client.proxyOrigin(containerId),
        headers: { Authorization: `Bearer ${agentToken(worker)}` },
      };
    },
  };
}
