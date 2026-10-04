import type {
  BrowserLaunchSettings,
  WorkerCreateBrowserRequest,
  WorkerCreateBrowserResponse,
  WorkerStatusResponse,
} from "./types";
import type {
  BrowserContainerInfo,
  ContainerStats,
  CreateBrowserContainerInput,
  ImagePullResult,
  ProfileVolumeInfo,
} from "../docker/container-runtime";

export type RemoteWorkerClient = {
  status(): Promise<WorkerStatusResponse>;
  host(): Promise<{ id: string; publicIp: string; activeSessions: number; host: unknown }>;
  volumes(): Promise<{ id: string; volumes: ProfileVolumeInfo[] }>;
  removeVolume(volumeName: string): Promise<void>;
  createBrowser(input: WorkerCreateBrowserRequest): Promise<WorkerCreateBrowserResponse>;
  inspect(containerId: string): Promise<BrowserContainerInfo | null>;
  stats(containerId: string): Promise<ContainerStats>;
  logs(containerId: string, tail?: number): Promise<string>;
  remove(containerId: string): Promise<void>;
  listManaged(): Promise<BrowserContainerInfo[]>;
  pullImages(images: string[]): Promise<ImagePullResult[]>;
  proxyOrigin(containerId: string): string;
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* ignore */
  }
  return `worker_http_${response.status}`;
}

export function createRemoteWorkerClient(opts: {
  baseUrl: string;
  token: string;
}): RemoteWorkerClient {
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${opts.token}`);
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${base}${path}`, { ...init, headers });
  }

  return {
    proxyOrigin(containerId) {
      return `${base}/v1/proxy/${encodeURIComponent(containerId)}`;
    },

    async status() {
      const response = await request("/v1/status");
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as WorkerStatusResponse;
    },

    async host() {
      const response = await request("/v1/host");
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as {
        id: string;
        publicIp: string;
        activeSessions: number;
        host: unknown;
      };
    },

    async volumes() {
      const response = await request("/v1/volumes");
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as { id: string; volumes: ProfileVolumeInfo[] };
    },

    async removeVolume(volumeName) {
      const response = await request(`/v1/volumes/${encodeURIComponent(volumeName)}`, {
        method: "DELETE",
      });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(await readError(response));
    },

    async createBrowser(input) {
      const response = await request("/v1/browsers", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as WorkerCreateBrowserResponse;
    },

    async inspect(containerId) {
      const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as BrowserContainerInfo;
    },

    async stats(containerId) {
      const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}/stats`);
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as ContainerStats;
    },

    async logs(containerId, tail = 80) {
      const response = await request(
        `/v1/browsers/${encodeURIComponent(containerId)}/logs?tail=${tail}`,
      );
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { logs?: string };
      return body.logs ?? "";
    },

    async remove(containerId) {
      const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}`, {
        method: "DELETE",
      });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(await readError(response));
    },

    async listManaged() {
      const response = await request("/v1/browsers");
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { browsers: BrowserContainerInfo[] };
      return body.browsers ?? [];
    },

    async pullImages(images) {
      const response = await request("/v1/images/pull", {
        method: "POST",
        body: JSON.stringify({ images }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { results: ImagePullResult[] };
      return body.results ?? [];
    },
  };
}

export function launchSettingsFromConfig(settings: BrowserLaunchSettings): BrowserLaunchSettings {
  return { ...settings };
}

export function toCreateInput(
  request: WorkerCreateBrowserRequest,
  webrtcPort: number,
): CreateBrowserContainerInput {
  return {
    sessionId: request.sessionId,
    owner: request.owner,
    subjectId: request.subjectId,
    browser: request.browser,
    webrtcPort,
    nekoAdminPassword: request.nekoAdminPassword,
    nekoUserPassword: request.nekoUserPassword,
    persistProfile: request.persistProfile,
    settings: request.settings,
  };
}
