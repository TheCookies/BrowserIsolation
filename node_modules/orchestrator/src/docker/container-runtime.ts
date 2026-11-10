import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { parseProfileVolumeName, profileStorageKey, profileVolumeName } from "../auth/identity";
import type { BrowserType, Config } from "../config";
import { imageForBrowser, policyMountForBrowser } from "../config";
import type { BrowserLaunchSettings } from "../workers/types";
import {
  LABEL_BROWSER,
  LABEL_MANAGED,
  LABEL_SUBJECT_KEY,
  LABEL_WEBRTC_PORT,
  managedLabels,
} from "./labels";
import { policyArchiveFromFile } from "./policy-tar";
import { clearProfileLockFiles, PROFILE_LOCK_BASENAMES } from "./profile-locks";
import { ensureWritableProfileHostDir } from "./profile-permissions";
import { profileContainerPath, profileHostDir, profileHostDirFromVolumeName } from "./profile-paths";

export type ImagePullResult = {
  image: string;
  ok: boolean;
  error?: string;
};

export type ImageRemoveResult = {
  image: string;
  ok: boolean;
  /** True when the image was already absent. */
  missing?: boolean;
  error?: string;
};

/** Live progress events while pulling container images (admin UI stream). */
export type ImagePullProgressEvent = {
  image: string;
  status: string;
  id?: string;
  current?: number;
  total?: number;
  percent?: number;
  detail?: string;
};

export type ImagePullProgressHandler = (event: ImagePullProgressEvent) => void;

export type CreateBrowserContainerInput = {
  sessionId: string;
  owner: string;
  /** Stable ownership id (local:… / saml:…). Used for profile volume naming. */
  subjectId: string;
  browser: BrowserType;
  webrtcPort: number;
  nekoAdminPassword: string;
  nekoUserPassword: string;
  /** Mount a per-user host directory (or named volume) and use persist policies. */
  persistProfile: boolean;
  /** Optional per-launch overrides (used by remote worker agents). */
  settings?: BrowserLaunchSettings;
};

export type BrowserContainerInfo = {
  id: string;
  name: string;
  ipAddress: string | null;
  /**
   * Preferred HTTP/WS origin for the orchestrator proxy.
   * When the orchestrator uses host networking (Podman), this is usually
   * http://127.0.0.1:<published-8080> so we do not rely on bridge DNS/routing.
   */
  proxyOrigin: string | null;
  running: boolean;
  status: string;
  labels: Record<string, string>;
};

export type ContainerStats = {
  cpuPercent: number | null;
  memoryBytes: number | null;
};

export type ProfileVolumeInfo = {
  name: string;
  subjectKey: string | null;
  browser: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  mountpoint: string | null;
};

export type ContainerRuntime = {
  ensureNetwork(): Promise<void>;
  createBrowserContainer(input: CreateBrowserContainerInput): Promise<BrowserContainerInfo>;
  inspect(containerId: string): Promise<BrowserContainerInfo | null>;
  stats(containerId: string): Promise<ContainerStats>;
  logs(containerId: string, tail?: number): Promise<string>;
  remove(containerId: string): Promise<void>;
  listManaged(): Promise<BrowserContainerInfo[]>;
  listProfileVolumes(): Promise<ProfileVolumeInfo[]>;
  removeProfileVolume(volumeName: string): Promise<void>;
  pullImages(images: string[], onProgress?: ImagePullProgressHandler): Promise<ImagePullResult[]>;
  removeImages(images: string[]): Promise<ImageRemoveResult[]>;
};

type DockerPullProgress = {
  status?: string;
  id?: string;
  progress?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message?: string };
};

function pullOneImage(
  docker: Docker,
  image: string,
  onProgress?: ImagePullProgressHandler,
): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(image, (error: Error | null, stream: NodeJS.ReadableStream) => {
      if (error) {
        reject(error);
        return;
      }
      const layers = new Map<string, { current: number; total: number }>();
      let lastEmitAt = 0;
      let lastStatusKey = "";

      const emit = (event: ImagePullProgressEvent, force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        const key = `${event.id ?? ""}:${event.status}:${event.percent ?? ""}`;
        if (!force && key === lastStatusKey && now - lastEmitAt < 200) return;
        lastStatusKey = key;
        lastEmitAt = now;
        onProgress(event);
      };

      docker.modem.followProgress(
        stream,
        (followError: Error | null) => {
          if (followError) reject(followError);
          else resolve();
        },
        (event: DockerPullProgress) => {
          if (!onProgress) return;
          if (event.error || event.errorDetail?.message) {
            emit(
              {
                image,
                status: "error",
                detail: event.error || event.errorDetail?.message,
              },
              true,
            );
            return;
          }
          const status = event.status?.trim() || "working";
          const id = event.id?.trim() || undefined;
          const current = event.progressDetail?.current;
          const total = event.progressDetail?.total;
          if (id && typeof current === "number" && typeof total === "number" && total > 0) {
            layers.set(id, { current, total });
          }
          let percent: number | undefined;
          if (layers.size > 0) {
            let sumCurrent = 0;
            let sumTotal = 0;
            for (const layer of layers.values()) {
              sumCurrent += layer.current;
              sumTotal += layer.total;
            }
            if (sumTotal > 0) {
              percent = Math.min(100, Math.round((sumCurrent / sumTotal) * 1000) / 10);
            }
          }
          emit({
            image,
            status,
            id,
            current: typeof current === "number" ? current : undefined,
            total: typeof total === "number" ? total : undefined,
            percent,
            detail: event.progress?.trim() || undefined,
          });
        },
      );
    });
  });
}

function cpuPercentFromStats(stats: Docker.ContainerStats): number | null {
  const cpuStats = stats.cpu_stats;
  const precpu = stats.precpu_stats;
  if (!cpuStats?.cpu_usage || !precpu?.cpu_usage) return null;
  const cpuDelta = (cpuStats.cpu_usage.total_usage ?? 0) - (precpu.cpu_usage.total_usage ?? 0);
  const systemDelta = (cpuStats.system_cpu_usage ?? 0) - (precpu.system_cpu_usage ?? 0);
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  const online =
    cpuStats.online_cpus ||
    cpuStats.cpu_usage.percpu_usage?.length ||
    1;
  return (cpuDelta / systemDelta) * online * 100;
}

function memoryBytesFromStats(stats: Docker.ContainerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (typeof usage !== "number") return null;
  const statsMap = stats.memory_stats?.stats as Record<string, number> | undefined;
  const cache = statsMap?.cache ?? statsMap?.total_inactive_file ?? 0;
  return Math.max(0, usage - (typeof cache === "number" ? cache : 0));
}

function containerNameFor(sessionId: string): string {
  return `rbi-${sessionId.slice(0, 12)}`;
}

type RuntimeView = Pick<
  Config,
  | "publicIp"
  | "webrtcIceLite"
  | "iceServersFrontend"
  | "iceServersBackend"
  | "desktopScreen"
  | "captureVideoCodec"
  | "allowClipboard"
  | "allowDownloads"
  | "browserShmSizeBytes"
  | "browserNanoCpus"
  | "browserMemoryBytes"
  | "nekoImageTag"
>;

function runtimeView(config: Config, settings?: BrowserLaunchSettings): RuntimeView {
  if (!settings) return config;
  return {
    publicIp: config.publicIp,
    webrtcIceLite: settings.webrtcIceLite,
    iceServersFrontend: settings.iceServersFrontend,
    iceServersBackend: settings.iceServersBackend,
    desktopScreen: settings.desktopScreen,
    captureVideoCodec: settings.captureVideoCodec,
    allowClipboard: settings.allowClipboard,
    allowDownloads: settings.allowDownloads,
    browserShmSizeBytes: settings.browserShmSizeBytes,
    browserNanoCpus: settings.browserNanoCpus,
    browserMemoryBytes: settings.browserMemoryBytes,
    nekoImageTag: settings.nekoImageTag,
  };
}

/**
 * Build Neko capture env so the remote X11 pointer is never in the video stream.
 *
 * Our portal viewer uses the legacy Neko WS API + the local OS cursor. Neko 3.1.x
 * with NEKO_LEGACY=true auto-creates a "legacy" pipeline that forces
 * show-pointer=true (so the old UI has a cursor). That produces a second, lagged
 * cursor on top of the local one. Avoid the singular NEKO_CAPTURE_VIDEO_PIPELINE
 * shorthand (that path rewrites show-pointer to true for legacy) and instead
 * publish both `main` and `legacy` pipelines with show-pointer=false hardcoded.
 */
export function buildNekoCapturePipelineEnv(
  config: Pick<Config, "captureVideoCodec">,
): string[] {
  // VP8 is the reliable default for browser WebRTC. Software H.264 often negotiates
  // but decodes as a black frame unless profile/packetization match the client.
  const pipeline =
    config.captureVideoCodec === "h264"
      ? "ximagesrc display-name={display} show-pointer=false use-damage=false " +
        "! videoconvert ! queue " +
        "! video/x-raw,format=I420 " +
        "! x264enc name=encoder threads=2 bitrate=3500 key-int-max=30 " +
        "byte-stream=true tune=zerolatency speed-preset=ultrafast " +
        "! video/x-h264,stream-format=byte-stream,profile=constrained-baseline " +
        "! appsink name=appsink"
      : // Tuned for 720p baseline with low-latency software encode; client may screen/set up to 1080p.
        "ximagesrc display-name={display} show-pointer=false use-damage=false " +
        "! video/x-raw,framerate=30/1 " +
        "! videoconvert ! queue " +
        "! vp8enc name=encoder target-bitrate=1996800 cpu-used=6 end-usage=cbr " +
        "threads=2 deadline=1 undershoot=95 buffer-size=12288 buffer-initial-size=6144 " +
        "buffer-optimal-size=9216 keyframe-max-dist=30 min-quantizer=4 max-quantizer=36 " +
        "! appsink name=appsink";

  const pipelines = JSON.stringify({
    main: { gst_pipeline: pipeline },
    // Legacy WS clients request this id; keep the pointer off here too.
    legacy: { gst_pipeline: pipeline },
  });

  return [
    `NEKO_CAPTURE_VIDEO_CODEC=${config.captureVideoCodec === "h264" ? "h264" : "vp8"}`,
    "NEKO_CAPTURE_VIDEO_IDS=main",
    "NEKO_CAPTURE_VIDEO_SHOW_POINTER=false",
    `NEKO_CAPTURE_VIDEO_PIPELINES=${pipelines}`,
  ];
}

function capturePipeline(config: Pick<Config, "captureVideoCodec">): string[] {
  return buildNekoCapturePipelineEnv(config);
}

function memberProfileJson(allowClipboard: boolean): string {
  return JSON.stringify({ can_access_clipboard: allowClipboard });
}

function nekoEnv(
  view: RuntimeView,
  input: CreateBrowserContainerInput,
  httpPort: number,
): string[] {
  // Neko serves at /. The orchestrator strips /session/:id/view when proxying.
  // Avoid NEKO_SERVER_PATH_PREFIX — legacy /ws auth breaks under a path prefix on 3.1.x.
  const clipboardProfile = memberProfileJson(view.allowClipboard);
  return [
    `NEKO_SERVER_BIND=0.0.0.0:${httpPort}`,
    "NEKO_SERVER_PROXY=true",
    "NEKO_SERVER_PATH_PREFIX=/",
    "NEKO_MEMBER_PROVIDER=multiuser",
    `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${input.nekoAdminPassword}`,
    `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${input.nekoUserPassword}`,
    `NEKO_MEMBER_MULTIUSER_ADMIN_PROFILE=${clipboardProfile}`,
    `NEKO_MEMBER_MULTIUSER_USER_PROFILE=${clipboardProfile}`,
    "NEKO_SESSION_IMPLICIT_HOSTING=true",
    // Collaborative cursor overlays are unused; local OS cursor is the only pointer.
    "NEKO_SESSION_INACTIVE_CURSORS=false",
    // Legacy /ws expects token auth, not cookies (see Neko config.yml notes for legacy API).
    "NEKO_SESSION_COOKIE_ENABLED=false",
    "NEKO_SESSION_MERCIFUL_RECONNECT=true",
    "NEKO_LEGACY=true",
    // File transfer is the path for user↔container downloads/uploads.
    `NEKO_FILETRANSFER_ENABLED=${view.allowDownloads ? "true" : "false"}`,
    "NEKO_FILETRANSFER_DIR=/home/neko/Downloads",
    `NEKO_FILETRANSFER_USER_DOWNLOAD=${view.allowDownloads ? "true" : "false"}`,
    `NEKO_FILETRANSFER_USER_UPLOAD=${view.allowDownloads ? "true" : "false"}`,
    `NEKO_WEBRTC_UDPMUX=${String(input.webrtcPort)}`,
    `NEKO_WEBRTC_TCPMUX=${String(input.webrtcPort)}`,
    `NEKO_WEBRTC_NAT1TO1=${view.publicIp}`,
    `NEKO_WEBRTC_ICELITE=${view.webrtcIceLite ? "true" : "false"}`,
    `NEKO_WEBRTC_ICESERVERS_FRONTEND=${view.iceServersFrontend}`,
    `NEKO_WEBRTC_ICESERVERS_BACKEND=${view.iceServersBackend}`,
    `NEKO_DESKTOP_SCREEN=${view.desktopScreen}`,
    "NEKO_CAPTURE_AUDIO_CODEC=opus",
    ...capturePipeline(view),
  ];
}

function readNetworkIp(
  inspection: Docker.ContainerInspectInfo,
  networkName: string,
): string | null {
  const networks = inspection.NetworkSettings?.Networks ?? {};
  const preferred = networks[networkName]?.IPAddress;
  if (preferred) return preferred;
  for (const network of Object.values(networks)) {
    if (network?.IPAddress) return network.IPAddress;
  }
  const legacyIp = (inspection.NetworkSettings as { IPAddress?: string } | undefined)?.IPAddress;
  return legacyIp || null;
}

function readPublishedHostPort(
  inspection: Docker.ContainerInspectInfo,
  containerPort: string,
): number | null {
  const bindings = inspection.NetworkSettings?.Ports?.[containerPort];
  if (!bindings?.length) return null;
  const preferred =
    bindings.find((row) => row.HostIp === "127.0.0.1") ??
    bindings.find((row) => !row.HostIp || row.HostIp === "0.0.0.0") ??
    bindings[0];
  const raw = preferred?.HostPort;
  if (!raw) return null;
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function toInfo(
  inspection: Docker.ContainerInspectInfo,
  networkName: string,
  networkMode: "bridge" | "host",
): BrowserContainerInfo {
  const name = inspection.Name.startsWith("/") ? inspection.Name.slice(1) : inspection.Name;
  const labels = inspection.Config?.Labels ?? {};
  const ipAddress = readNetworkIp(inspection, networkName);
  const publishedHttp = readPublishedHostPort(inspection, "8080/tcp");

  let proxyOrigin: string | null = null;
  if (networkMode === "host") {
    const webrtc = Number.parseInt(labels[LABEL_WEBRTC_PORT] ?? "", 10);
    if (Number.isFinite(webrtc) && webrtc > 0) {
      proxyOrigin = `http://127.0.0.1:${webrtc + 10000}`;
    }
  } else if (publishedHttp) {
    proxyOrigin = `http://127.0.0.1:${publishedHttp}`;
  } else if (ipAddress) {
    proxyOrigin = `http://${ipAddress}:8080`;
  }

  return {
    id: inspection.Id,
    name,
    ipAddress: networkMode === "host" ? "127.0.0.1" : ipAddress,
    proxyOrigin,
    running: Boolean(inspection.State?.Running),
    status: inspection.State?.Status ?? "unknown",
    labels,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    const error = new Error("invalid_volume");
    (error as { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return resolved;
}

function directorySizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function listHostProfileVolumes(profileDataDir: string): ProfileVolumeInfo[] {
  if (!profileDataDir || !existsSync(profileDataDir)) return [];
  const results: ProfileVolumeInfo[] = [];
  for (const subject of readdirSync(profileDataDir, { withFileTypes: true })) {
    if (!subject.isDirectory() || !/^[a-f0-9]{32}$/.test(subject.name)) continue;
    const subjectDir = path.join(profileDataDir, subject.name);
    for (const browser of readdirSync(subjectDir, { withFileTypes: true })) {
      if (!browser.isDirectory()) continue;
      const mountpoint = path.join(subjectDir, browser.name);
      let createdAt: string | null = null;
      let sizeBytes: number | null = null;
      try {
        createdAt = statSync(mountpoint).mtime.toISOString();
        sizeBytes = directorySizeBytes(mountpoint);
      } catch {
        /* listing is best-effort */
      }
      results.push({
        name: `rbi-profile-${subject.name}-${browser.name}`,
        subjectKey: subject.name,
        browser: browser.name,
        sizeBytes,
        createdAt,
        mountpoint,
      });
    }
  }
  return results;
}

export function createDockerRuntime(config: Config): ContainerRuntime {
  const docker = new Docker({ socketPath: config.dockerSocketPath });

  async function removeContainersSharingProfile(
    subjectId: string,
    subjectKey: string,
    browser: BrowserType,
  ): Promise<void> {
    const ids = new Set<string>();
    try {
      const labeled = await docker.listContainers({
        all: true,
        filters: {
          label: [
            `${LABEL_MANAGED}=true`,
            `${LABEL_SUBJECT_KEY}=${subjectKey}`,
            `${LABEL_BROWSER}=${browser}`,
          ],
        },
      });
      for (const item of labeled) ids.add(item.Id);
    } catch {
      /* fall through to mount scan */
    }

    // Older containers lack rbi.subject_key — match by mounted profile path/volume.
    const volumeName = profileVolumeName(subjectId, browser);
    const hostDir = config.profileDataDir
      ? profileHostDir(config.profileDataDir, subjectId, browser)
      : null;
    const hostNorm = hostDir ? hostDir.replace(/\\/g, "/").replace(/\/+$/, "") : "";
    const hostSuffix = `/${subjectKey}/${browser}`;
    try {
      const managed = await docker.listContainers({
        all: true,
        filters: {
          label: [`${LABEL_MANAGED}=true`, `${LABEL_BROWSER}=${browser}`],
        },
      });
      for (const item of managed) {
        if (ids.has(item.Id)) continue;
        try {
          const inspection = await docker.getContainer(item.Id).inspect();
          const mounts = inspection.Mounts ?? [];
          const hit = mounts.some((mount) => {
            if (mount.Type === "volume" && mount.Name === volumeName) return true;
            const source = (mount.Source ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
            if (!source) return false;
            if (hostNorm && source === hostNorm) return true;
            // Podman may report a resolved/different Source; match by subject key path.
            if (source.endsWith(hostSuffix) || source.includes(`${hostSuffix}/`)) return true;
            return false;
          });
          if (hit) ids.add(item.Id);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* best-effort */
    }

    for (const id of ids) {
      try {
        // Force-remove immediately — stuck Firefox holding .parentlock will not
        // exit cleanly within a stop grace period.
        await thisRemove(id, { quick: true });
      } catch {
        /* best-effort */
      }
    }
  }

  async function thisRemove(
    containerId: string,
    options?: { quick?: boolean },
  ): Promise<void> {
    const container = docker.getContainer(containerId);
    if (!options?.quick) {
      try {
        await container.stop({ t: 20 });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode !== 304 && statusCode !== 404) {
          /* force remove below */
        }
      }
    }
    try {
      await container.remove({ force: true, v: false });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw error;
    }
  }

  /**
   * Drop stale Firefox/Chromium lock files from a reusable profile so the next
   * session does not hit “Firefox is already running but is not responding”.
   */
  async function clearPersistedProfileLocks(input: {
    subjectId: string;
    browser: BrowserType;
    image: string;
  }): Promise<void> {
    if (config.profileDataDir) {
      const hostDir = profileHostDir(config.profileDataDir, input.subjectId, input.browser);
      clearProfileLockFiles(hostDir);
      return;
    }

    const volumeName = profileVolumeName(input.subjectId, input.browser);
    try {
      const inspected = (await docker.getVolume(volumeName).inspect()) as {
        Mountpoint?: string;
      };
      const mountpoint = inspected.Mountpoint?.trim();
      if (mountpoint && existsSync(mountpoint)) {
        clearProfileLockFiles(mountpoint);
        return;
      }
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      // 404 = first launch, volume not created yet — nothing to clear.
      if (statusCode === 404) return;
    }

    // Mountpoint not visible from this process (common in some Podman setups).
    // Use a one-shot helper with the browser image (already local) to rm locks.
    const lockPaths = PROFILE_LOCK_BASENAMES.map((name) => `/profile/${name}`).join(" ");
    const helperName = `rbi-profile-unlock-${Date.now().toString(36)}`;
    let helperId: string | null = null;
    try {
      const helper = await docker.createContainer({
        name: helperName,
        Image: input.image,
        Entrypoint: ["sh", "-c"],
        Cmd: [`rm -f ${lockPaths}; exit 0`],
        Labels: {
          [LABEL_MANAGED]: "true",
          "rbi.purpose": "profile-unlock",
        },
        HostConfig: {
          AutoRemove: false,
          Mounts: [
            {
              Type: "volume",
              Source: volumeName,
              Target: "/profile",
              ReadOnly: false,
            },
          ],
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
        },
      });
      helperId = helper.id;
      await helper.start();
      await helper.wait({ condition: "not-running" });
    } catch {
      /* best-effort — session start still proceeds */
    } finally {
      if (helperId) {
        try {
          await docker.getContainer(helperId).remove({ force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function readLogs(containerId: string, tail = 80): Promise<string> {
    try {
      const buffer = await docker.getContainer(containerId).logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: false,
      });
      // dockerode may return a Buffer with multiplexed headers; strip crude control chars.
      return buffer
        .toString("utf8")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(-4000);
    } catch {
      return "";
    }
  }

  return {
    async ensureNetwork() {
      if (config.browserNetworkMode === "host") return;
      const networks = await docker.listNetworks({
        filters: { name: [config.browserNetwork] },
      });
      const exact = networks.find((network) => network.Name === config.browserNetwork);
      if (exact) return;
      await docker.createNetwork({
        Name: config.browserNetwork,
        Driver: "bridge",
        CheckDuplicate: true,
        Labels: { [LABEL_MANAGED]: "true" },
      });
    },

    async createBrowserContainer(input) {
      await this.ensureNetwork();
      const view = runtimeView(config, input.settings);
      const launchConfig: Config = { ...config, ...view };
      const name = containerNameFor(input.sessionId);
      const subjectKey = profileStorageKey(input.subjectId);
      const labels = managedLabels({
        owner: input.owner,
        subjectKey,
        sessionId: input.sessionId,
        browser: input.browser,
        webrtcPort: input.webrtcPort,
      });
      const port = String(input.webrtcPort);
      // Host mode: HTTP cannot stay on 8080 (orchestrator uses it). Offset WebRTC port.
      const httpPort =
        config.browserNetworkMode === "host" ? input.webrtcPort + 10000 : 8080;
      const useHostNet = config.browserNetworkMode === "host";
      const mounts: Array<{ Type: "volume"; Source: string; Target: string; ReadOnly: boolean }> = [];
      const binds: string[] = [];

      if (input.persistProfile) {
        const target = profileContainerPath(input.browser);
        // LDAP users can miss username-keyed destroy and leave a live container on
        // the same profile volume — remove those before remounting.
        await removeContainersSharingProfile(input.subjectId, subjectKey, input.browser);
        // Previous force-killed sessions leave Firefox/Chromium lock files behind.
        await clearPersistedProfileLocks({
          subjectId: input.subjectId,
          browser: input.browser,
          image: imageForBrowser(launchConfig, input.browser),
        });
        if (config.profileDataDir) {
          const hostDir = profileHostDir(config.profileDataDir, input.subjectId, input.browser);
          // Neko runs as UID 1000 — root-owned bind mounts cannot be written
          // (empty 0B profiles + Firefox “already running” lock errors).
          ensureWritableProfileHostDir(hostDir);
          // :Z so SELinux allows the Neko user to write cookies/config on the HDD.
          binds.push(`${hostDir}:${target}:Z`);
        } else {
          const volumeName = profileVolumeName(input.subjectId, input.browser);
          try {
            await docker.createVolume({
              Name: volumeName,
              Labels: {
                [LABEL_MANAGED]: "true",
                "rbi.subject_key": profileStorageKey(input.subjectId),
                "rbi.browser": input.browser,
              },
            });
          } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            // 409 = volume already exists
            if (statusCode !== 409) throw error;
          }
          mounts.push({
            Type: "volume",
            Source: volumeName,
            Target: target,
            ReadOnly: false,
          });
        }
      }

      const container = await docker.createContainer({
        name,
        Image: imageForBrowser(launchConfig, input.browser),
        Env: nekoEnv(view, input, httpPort),
        Labels: labels,
        ...(useHostNet
          ? {}
          : {
              NetworkingConfig: {
                EndpointsConfig: {
                  [config.browserNetwork]: {},
                },
              },
            }),
        HostConfig: {
          Init: true,
          ShmSize: view.browserShmSizeBytes,
          NanoCpus: view.browserNanoCpus,
          Memory: view.browserMemoryBytes,
          CapDrop: ["ALL"],
          // Capabilities Neko/Chrome need inside the image (no privileged mode).
          CapAdd: [
            "AUDIT_WRITE",
            "CHOWN",
            "DAC_OVERRIDE",
            "FOWNER",
            "SETGID",
            "SETUID",
            "SETPCAP",
            "SYS_ADMIN",
            "SYS_CHROOT",
            "NET_BIND_SERVICE",
            "KILL",
            "MKNOD",
          ],
          // Chrome's sandbox syscalls are outside Docker's default seccomp profile.
          SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"],
          NetworkMode: useHostNet ? "host" : config.browserNetwork,
          // Host mode binds ports directly (no DNAT). Bridge mode publishes ports.
          ...(useHostNet
            ? {}
            : {
                PortBindings: {
                  [`${port}/udp`]: [{ HostIp: "0.0.0.0", HostPort: port }],
                  [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: port }],
                  "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
                },
              }),
          RestartPolicy: { Name: "no" },
          Binds: binds.length > 0 ? binds : undefined,
          Mounts: mounts.length > 0 ? mounts : undefined,
        },
        ...(useHostNet
          ? {}
          : {
              ExposedPorts: {
                [`${port}/udp`]: {},
                [`${port}/tcp`]: {},
                "8080/tcp": {},
              },
            }),
      });

      // Replace Neko's default managed policy (removes force-installed SponsorBlock).
      // Persist mode uses policies that keep cookies/session data across restarts.
      // See https://neko.m1k1o.net/docs/v3/customization/browsers
      const mount = policyMountForBrowser(input.browser);
      if (mount?.policySource) {
        const policyName = input.persistProfile ? "policies.persist.json" : "policies.json";
        const policyFile = path.join(config.nekoPoliciesDir, mount.policySource, policyName);
        if (!existsSync(policyFile)) {
          await container.remove({ force: true }).catch(() => undefined);
          throw new Error(`browser_policy_missing: ${policyFile}`);
        }
        await container.putArchive(
          policyArchiveFromFile(policyFile, {
            policySource: mount.policySource,
            allowDownloads: view.allowDownloads,
          }),
          { path: mount.dir },
        );
      }

      await container.start();

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const inspection = await container.inspect();
        const info = toInfo(inspection, config.browserNetwork, config.browserNetworkMode);
        if (info.running) {
          if (useHostNet) {
            return {
              ...info,
              ipAddress: "127.0.0.1",
              proxyOrigin: `http://127.0.0.1:${httpPort}`,
            };
          }
          if (info.proxyOrigin || info.ipAddress) {
            return info;
          }
        }
        if (!info.running && attempt >= 4) {
          const logs = await readLogs(container.id);
          throw new Error(
            `container_exited status=${info.status}${logs ? `: ${logs}` : ""}`,
          );
        }
        await sleep(250);
      }

      const latest = toInfo(
        await container.inspect(),
        config.browserNetwork,
        config.browserNetworkMode,
      );
      if (useHostNet && latest.running) {
        return {
          ...latest,
          ipAddress: "127.0.0.1",
          proxyOrigin: `http://127.0.0.1:${httpPort}`,
        };
      }
      if (!latest.proxyOrigin && !latest.ipAddress) {
        const logs = await readLogs(container.id);
        throw new Error(`container_missing_ip${logs ? `: ${logs}` : ""}`);
      }
      return latest;
    },

    async inspect(containerId) {
      try {
        const inspection = await docker.getContainer(containerId).inspect();
        return toInfo(inspection, config.browserNetwork, config.browserNetworkMode);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404) return null;
        throw error;
      }
    },

    async stats(containerId) {
      try {
        const raw = (await docker.getContainer(containerId).stats({ stream: false })) as Docker.ContainerStats;
        return {
          cpuPercent: cpuPercentFromStats(raw),
          memoryBytes: memoryBytesFromStats(raw),
        };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404) {
          return { cpuPercent: null, memoryBytes: null };
        }
        throw error;
      }
    },

    async logs(containerId, tail = 80) {
      return readLogs(containerId, tail);
    },

    async remove(containerId) {
      // Never pass v:true — that deletes volumes. Persistent profiles must
      // survive session destroy / portal auto-update.
      await thisRemove(containerId);
    },

    async listManaged() {
      const list = await docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_MANAGED}=true`] },
      });
      const results: BrowserContainerInfo[] = [];
      for (const item of list) {
        const info = await this.inspect(item.Id);
        if (info) results.push(info);
      }
      return results;
    },

    async listProfileVolumes() {
      const byName = new Map<string, ProfileVolumeInfo>();
      for (const volume of listHostProfileVolumes(config.profileDataDir)) {
        byName.set(volume.name, volume);
      }

      const listed = await docker.listVolumes({
        filters: { label: [`${LABEL_MANAGED}=true`] },
      });
      const volumes = (listed.Volumes ?? []).filter((volume) =>
        Boolean(volume.Name?.startsWith("rbi-profile-")),
      );

      const sizeByName = new Map<string, number>();
      try {
        const df = (await docker.df()) as {
          Volumes?: Array<{
            Name?: string;
            Size?: number;
            UsageData?: { Size?: number; RefCount?: number };
          }>;
        };
        for (const volume of df.Volumes ?? []) {
          if (!volume.Name) continue;
          const size =
            typeof volume.UsageData?.Size === "number"
              ? volume.UsageData.Size
              : typeof volume.Size === "number"
                ? volume.Size
                : null;
          if (size !== null) sizeByName.set(volume.Name, size);
        }
      } catch {
        /* Size requires docker system df; leave null if unavailable. */
      }

      for (const volume of volumes) {
        const name = volume.Name ?? "";
        if (!name || byName.has(name)) continue;
        const labels = (volume.Labels ?? {}) as Record<string, string>;
        const parsed = parseProfileVolumeName(name);
        const createdRaw = (volume as unknown as { CreatedAt?: string }).CreatedAt;
        const createdAt = typeof createdRaw === "string" ? createdRaw : null;
        byName.set(name, {
          name,
          subjectKey: labels["rbi.subject_key"] ?? parsed?.subjectKey ?? null,
          browser: labels["rbi.browser"] ?? labels[LABEL_BROWSER] ?? parsed?.browser ?? null,
          sizeBytes: sizeByName.get(name) ?? null,
          createdAt,
          mountpoint: volume.Mountpoint ?? null,
        });
      }

      return [...byName.values()];
    },

    async removeProfileVolume(volumeName) {
      const parsed = parseProfileVolumeName(volumeName);
      if (!parsed) {
        const error = new Error("invalid_volume");
        (error as { statusCode?: number }).statusCode = 400;
        throw error;
      }

      let removedHost = false;
      if (config.profileDataDir) {
        const hostDir = profileHostDirFromVolumeName(config.profileDataDir, volumeName);
        if (hostDir) {
          const safe = assertPathInside(config.profileDataDir, hostDir);
          if (existsSync(safe)) {
            rmSync(safe, { recursive: true, force: true });
            removedHost = true;
          }
        }
      }

      let namedMissing = false;
      try {
        const inspection = await docker.getVolume(volumeName).inspect();
        const labels = (inspection.Labels ?? {}) as Record<string, string>;
        if (labels[LABEL_MANAGED] !== "true") {
          const error = new Error("not_managed");
          (error as { statusCode?: number }).statusCode = 403;
          throw error;
        }
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 403 || statusCode === 400) throw error;
        if (statusCode === 404) namedMissing = true;
      }

      if (!namedMissing) {
        try {
          await docker.getVolume(volumeName).remove({ force: false });
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 409) {
            const busy = new Error("volume_in_use");
            (busy as { statusCode?: number }).statusCode = 409;
            throw busy;
          }
          if (statusCode !== 404) throw error;
        }
      }

      if (!removedHost && namedMissing) {
        const missing = new Error("not_found");
        (missing as { statusCode?: number }).statusCode = 404;
        throw missing;
      }
    },

    async pullImages(images, onProgress) {
      const results: ImagePullResult[] = [];
      for (const image of images) {
        try {
          onProgress?.({ image, status: "Pulling", detail: `Starting ${image}` });
          await pullOneImage(docker, image, onProgress);
          onProgress?.({ image, status: "complete", percent: 100, detail: "Pull complete" });
          results.push({ image, ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onProgress?.({ image, status: "error", detail: message });
          results.push({
            image,
            ok: false,
            error: message,
          });
        }
      }
      return results;
    },

    async removeImages(images) {
      const results: ImageRemoveResult[] = [];
      for (const image of images) {
        try {
          await docker.getImage(image).remove({ force: true });
          results.push({ image, ok: true });
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404) {
            results.push({ image, ok: true, missing: true });
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          results.push({ image, ok: false, error: message });
        }
      }
      return results;
    },
  };
}
