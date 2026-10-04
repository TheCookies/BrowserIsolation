import type { Config } from "../config";
import type {
  BrowserContainerInfo,
  ContainerRuntime,
  ContainerStats,
  ImagePullResult,
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
  }): WorkerRecord;
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
  pullImages(images: string[]): Promise<Array<ImagePullResult & { workerId: string }>>;
  proxyTarget(workerId: string, containerId: string, containerName: string): ProxyTarget;
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

  function remote(worker: WorkerRecord) {
    return createRemoteWorkerClient({ baseUrl: worker.baseUrl, token: worker.token });
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
      const workers = store.list();
      // Refresh local active count from SQLite-backed sessions is handled externally;
      // use stored activeSessions for remotes and for local.
      const picked = pickWorker(workers, { stickyWorkerId: sticky });
      if (!picked) {
        throw Object.assign(new Error("no_workers_available"), { statusCode: 503 });
      }
      return picked;
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

    async pullImages(images) {
      const results: Array<ImagePullResult & { workerId: string }> = [];
      for (const worker of store.list()) {
        if (!worker.enabled) continue;
        try {
          if (worker.kind === "local") {
            const pulled = await localRuntime.pullImages(images);
            for (const item of pulled) results.push({ ...item, workerId: worker.id });
          } else {
            const pulled = await remote(worker).pullImages(images);
            for (const item of pulled) results.push({ ...item, workerId: worker.id });
          }
        } catch (error) {
          for (const image of images) {
            results.push({
              image,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              workerId: worker.id,
            });
          }
        }
      }
      return results;
    },

    proxyTarget(workerId, containerId, containerName) {
      const worker = requireWorker(workerId);
      if (worker.kind === "local") {
        return { targetOrigin: `http://${containerName}:8080` };
      }
      const client = remote(worker);
      return {
        targetOrigin: client.proxyOrigin(containerId),
        headers: { Authorization: `Bearer ${worker.token}` },
      };
    },
  };
}
