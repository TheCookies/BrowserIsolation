"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDockerRuntime = createDockerRuntime;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const dockerode_1 = __importDefault(require("dockerode"));
const identity_1 = require("../auth/identity");
const config_1 = require("../config");
const labels_1 = require("./labels");
const policy_tar_1 = require("./policy-tar");
const profile_paths_1 = require("./profile-paths");
function pullOneImage(docker, image, onProgress) {
    return new Promise((resolve, reject) => {
        docker.pull(image, (error, stream) => {
            if (error) {
                reject(error);
                return;
            }
            const layers = new Map();
            let lastEmitAt = 0;
            let lastStatusKey = "";
            const emit = (event, force = false) => {
                if (!onProgress)
                    return;
                const now = Date.now();
                const key = `${event.id ?? ""}:${event.status}:${event.percent ?? ""}`;
                if (!force && key === lastStatusKey && now - lastEmitAt < 200)
                    return;
                lastStatusKey = key;
                lastEmitAt = now;
                onProgress(event);
            };
            docker.modem.followProgress(stream, (followError) => {
                if (followError)
                    reject(followError);
                else
                    resolve();
            }, (event) => {
                if (!onProgress)
                    return;
                if (event.error || event.errorDetail?.message) {
                    emit({
                        image,
                        status: "error",
                        detail: event.error || event.errorDetail?.message,
                    }, true);
                    return;
                }
                const status = event.status?.trim() || "working";
                const id = event.id?.trim() || undefined;
                const current = event.progressDetail?.current;
                const total = event.progressDetail?.total;
                if (id && typeof current === "number" && typeof total === "number" && total > 0) {
                    layers.set(id, { current, total });
                }
                let percent;
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
            });
        });
    });
}
function cpuPercentFromStats(stats) {
    const cpuStats = stats.cpu_stats;
    const precpu = stats.precpu_stats;
    if (!cpuStats?.cpu_usage || !precpu?.cpu_usage)
        return null;
    const cpuDelta = (cpuStats.cpu_usage.total_usage ?? 0) - (precpu.cpu_usage.total_usage ?? 0);
    const systemDelta = (cpuStats.system_cpu_usage ?? 0) - (precpu.system_cpu_usage ?? 0);
    if (cpuDelta <= 0 || systemDelta <= 0)
        return 0;
    const online = cpuStats.online_cpus ||
        cpuStats.cpu_usage.percpu_usage?.length ||
        1;
    return (cpuDelta / systemDelta) * online * 100;
}
function memoryBytesFromStats(stats) {
    const usage = stats.memory_stats?.usage;
    if (typeof usage !== "number")
        return null;
    const statsMap = stats.memory_stats?.stats;
    const cache = statsMap?.cache ?? statsMap?.total_inactive_file ?? 0;
    return Math.max(0, usage - (typeof cache === "number" ? cache : 0));
}
function containerNameFor(sessionId) {
    return `rbi-${sessionId.slice(0, 12)}`;
}
function runtimeView(config, settings) {
    if (!settings)
        return config;
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
function capturePipeline(config) {
    // VP8 is the reliable default for browser WebRTC. Software H.264 often negotiates
    // but decodes as a black frame unless profile/packetization match the client.
    if (config.captureVideoCodec === "h264") {
        const pipeline = "ximagesrc display-name={display} show-pointer=true use-damage=false " +
            "! videoconvert ! queue " +
            "! video/x-raw,format=I420 " +
            "! x264enc name=encoder threads=2 bitrate=3500 key-int-max=30 " +
            "byte-stream=true tune=zerolatency speed-preset=ultrafast " +
            "! video/x-h264,stream-format=byte-stream,profile=constrained-baseline " +
            "! appsink name=appsink";
        return [
            "NEKO_CAPTURE_VIDEO_CODEC=h264",
            "NEKO_CAPTURE_VIDEO_SHOW_POINTER=true",
            `NEKO_CAPTURE_VIDEO_PIPELINE=${pipeline}`,
        ];
    }
    // Tuned for 720p baseline with low-latency software encode; client may screen/set up to 1080p.
    const pipelines = JSON.stringify({
        hq: {
            fps: 30,
            show_pointer: true,
            gst_encoder: "vp8enc",
            gst_params: {
                "target-bitrate": "round(3072 * 650)",
                "cpu-used": 6,
                "end-usage": "cbr",
                threads: 2,
                deadline: 1,
                undershoot: 95,
                "buffer-size": "(3072 * 4)",
                "buffer-initial-size": "(3072 * 2)",
                "buffer-optimal-size": "(3072 * 3)",
                "keyframe-max-dist": 30,
                "min-quantizer": 4,
                "max-quantizer": 36,
            },
        },
    });
    return [
        "NEKO_CAPTURE_VIDEO_CODEC=vp8",
        "NEKO_CAPTURE_VIDEO_IDS=hq",
        "NEKO_CAPTURE_VIDEO_SHOW_POINTER=true",
        `NEKO_CAPTURE_VIDEO_PIPELINES=${pipelines}`,
    ];
}
function memberProfileJson(allowClipboard) {
    return JSON.stringify({ can_access_clipboard: allowClipboard });
}
function nekoEnv(view, input) {
    // Neko serves at /. The orchestrator strips /session/:id/view when proxying.
    // Avoid NEKO_SERVER_PATH_PREFIX — legacy /ws auth breaks under a path prefix on 3.1.x.
    const clipboardProfile = memberProfileJson(view.allowClipboard);
    return [
        "NEKO_SERVER_BIND=0.0.0.0:8080",
        "NEKO_SERVER_PROXY=true",
        "NEKO_SERVER_PATH_PREFIX=/",
        "NEKO_MEMBER_PROVIDER=multiuser",
        `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${input.nekoAdminPassword}`,
        `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${input.nekoUserPassword}`,
        `NEKO_MEMBER_MULTIUSER_ADMIN_PROFILE=${clipboardProfile}`,
        `NEKO_MEMBER_MULTIUSER_USER_PROFILE=${clipboardProfile}`,
        "NEKO_SESSION_IMPLICIT_HOSTING=true",
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
function readNetworkIp(inspection, networkName) {
    const networks = inspection.NetworkSettings?.Networks ?? {};
    const preferred = networks[networkName]?.IPAddress;
    if (preferred)
        return preferred;
    for (const network of Object.values(networks)) {
        if (network?.IPAddress)
            return network.IPAddress;
    }
    const legacyIp = inspection.NetworkSettings?.IPAddress;
    return legacyIp || null;
}
function toInfo(inspection, networkName) {
    const name = inspection.Name.startsWith("/") ? inspection.Name.slice(1) : inspection.Name;
    return {
        id: inspection.Id,
        name,
        ipAddress: readNetworkIp(inspection, networkName),
        running: Boolean(inspection.State?.Running),
        status: inspection.State?.Status ?? "unknown",
        labels: inspection.Config?.Labels ?? {},
    };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function createDockerRuntime(config) {
    const docker = new dockerode_1.default({ socketPath: config.dockerSocketPath });
    async function readLogs(containerId, tail = 80) {
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
        }
        catch {
            return "";
        }
    }
    return {
        async ensureNetwork() {
            const networks = await docker.listNetworks({
                filters: { name: [config.browserNetwork] },
            });
            const exact = networks.find((network) => network.Name === config.browserNetwork);
            if (exact)
                return;
            await docker.createNetwork({
                Name: config.browserNetwork,
                Driver: "bridge",
                CheckDuplicate: true,
                Labels: { [labels_1.LABEL_MANAGED]: "true" },
            });
        },
        async createBrowserContainer(input) {
            await this.ensureNetwork();
            const view = runtimeView(config, input.settings);
            const launchConfig = { ...config, ...view };
            const name = containerNameFor(input.sessionId);
            const labels = (0, labels_1.managedLabels)({
                owner: input.owner,
                sessionId: input.sessionId,
                browser: input.browser,
                webrtcPort: input.webrtcPort,
            });
            const port = String(input.webrtcPort);
            const mounts = [];
            if (input.persistProfile) {
                const volumeName = (0, identity_1.profileVolumeName)(input.subjectId, input.browser);
                try {
                    await docker.createVolume({
                        Name: volumeName,
                        Labels: {
                            [labels_1.LABEL_MANAGED]: "true",
                            "rbi.subject_key": (0, identity_1.profileStorageKey)(input.subjectId),
                            "rbi.browser": input.browser,
                        },
                    });
                }
                catch (error) {
                    const statusCode = error.statusCode;
                    // 409 = volume already exists
                    if (statusCode !== 409)
                        throw error;
                }
                mounts.push({
                    Type: "volume",
                    Source: volumeName,
                    Target: (0, profile_paths_1.profileContainerPath)(input.browser),
                    ReadOnly: false,
                });
            }
            const container = await docker.createContainer({
                name,
                Image: (0, config_1.imageForBrowser)(launchConfig, input.browser),
                Env: nekoEnv(view, input),
                Labels: labels,
                // Join the browser network via EndpointsConfig (not NetworkMode=name) so
                // PortBindings keep working under Podman as well as Docker.
                NetworkingConfig: {
                    EndpointsConfig: {
                        [config.browserNetwork]: {},
                    },
                },
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
                    PortBindings: {
                        [`${port}/udp`]: [{ HostIp: "0.0.0.0", HostPort: port }],
                        [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: port }],
                    },
                    RestartPolicy: { Name: "no" },
                    Mounts: mounts.length > 0 ? mounts : undefined,
                },
                ExposedPorts: {
                    [`${port}/udp`]: {},
                    [`${port}/tcp`]: {},
                },
            });
            // Replace Neko's default managed policy (removes force-installed SponsorBlock).
            // Persist mode uses policies that keep cookies/session data across restarts.
            // See https://neko.m1k1o.net/docs/v3/customization/browsers
            const mount = (0, config_1.policyMountForBrowser)(input.browser);
            if (mount?.policySource) {
                const policyName = input.persistProfile ? "policies.persist.json" : "policies.json";
                const policyFile = node_path_1.default.join(config.nekoPoliciesDir, mount.policySource, policyName);
                if (!(0, node_fs_1.existsSync)(policyFile)) {
                    await container.remove({ force: true }).catch(() => undefined);
                    throw new Error(`browser_policy_missing: ${policyFile}`);
                }
                await container.putArchive((0, policy_tar_1.policyArchiveFromFile)(policyFile, {
                    policySource: mount.policySource,
                    allowDownloads: view.allowDownloads,
                }), { path: mount.dir });
            }
            await container.start();
            for (let attempt = 0; attempt < 40; attempt += 1) {
                const inspection = await container.inspect();
                const info = toInfo(inspection, config.browserNetwork);
                if (info.running && info.ipAddress) {
                    return info;
                }
                if (!info.running && attempt >= 4) {
                    const logs = await readLogs(container.id);
                    throw new Error(`container_exited status=${info.status}${logs ? `: ${logs}` : ""}`);
                }
                await sleep(250);
            }
            const latest = toInfo(await container.inspect(), config.browserNetwork);
            if (!latest.ipAddress) {
                const logs = await readLogs(container.id);
                throw new Error(`container_missing_ip${logs ? `: ${logs}` : ""}`);
            }
            return latest;
        },
        async inspect(containerId) {
            try {
                const inspection = await docker.getContainer(containerId).inspect();
                return toInfo(inspection, config.browserNetwork);
            }
            catch (error) {
                const statusCode = error.statusCode;
                if (statusCode === 404)
                    return null;
                throw error;
            }
        },
        async stats(containerId) {
            try {
                const raw = (await docker.getContainer(containerId).stats({ stream: false }));
                return {
                    cpuPercent: cpuPercentFromStats(raw),
                    memoryBytes: memoryBytesFromStats(raw),
                };
            }
            catch (error) {
                const statusCode = error.statusCode;
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
            const container = docker.getContainer(containerId);
            try {
                await container.stop({ t: 10 });
            }
            catch (error) {
                const statusCode = error.statusCode;
                if (statusCode !== 304 && statusCode !== 404) {
                    // Force remove below even if stop failed for other reasons.
                }
            }
            try {
                await container.remove({ force: true, v: true });
            }
            catch (error) {
                const statusCode = error.statusCode;
                if (statusCode !== 404)
                    throw error;
            }
        },
        async listManaged() {
            const list = await docker.listContainers({
                all: true,
                filters: { label: [`${labels_1.LABEL_MANAGED}=true`] },
            });
            const results = [];
            for (const item of list) {
                const info = await this.inspect(item.Id);
                if (info)
                    results.push(info);
            }
            return results;
        },
        async listProfileVolumes() {
            const listed = await docker.listVolumes({
                filters: { label: [`${labels_1.LABEL_MANAGED}=true`] },
            });
            const volumes = (listed.Volumes ?? []).filter((volume) => Boolean(volume.Name?.startsWith("rbi-profile-")));
            const sizeByName = new Map();
            try {
                const df = (await docker.df());
                for (const volume of df.Volumes ?? []) {
                    if (!volume.Name)
                        continue;
                    const size = typeof volume.UsageData?.Size === "number"
                        ? volume.UsageData.Size
                        : typeof volume.Size === "number"
                            ? volume.Size
                            : null;
                    if (size !== null)
                        sizeByName.set(volume.Name, size);
                }
            }
            catch {
                /* Size requires docker system df; leave null if unavailable. */
            }
            return volumes.map((volume) => {
                const name = volume.Name ?? "";
                const labels = (volume.Labels ?? {});
                const parsed = (0, identity_1.parseProfileVolumeName)(name);
                const createdRaw = volume.CreatedAt;
                const createdAt = typeof createdRaw === "string" ? createdRaw : null;
                return {
                    name,
                    subjectKey: labels["rbi.subject_key"] ?? parsed?.subjectKey ?? null,
                    browser: labels["rbi.browser"] ?? labels[labels_1.LABEL_BROWSER] ?? parsed?.browser ?? null,
                    sizeBytes: sizeByName.get(name) ?? null,
                    createdAt,
                    mountpoint: volume.Mountpoint ?? null,
                };
            });
        },
        async removeProfileVolume(volumeName) {
            const parsed = (0, identity_1.parseProfileVolumeName)(volumeName);
            if (!parsed) {
                const error = new Error("invalid_volume");
                error.statusCode = 400;
                throw error;
            }
            try {
                const inspection = await docker.getVolume(volumeName).inspect();
                const labels = (inspection.Labels ?? {});
                if (labels[labels_1.LABEL_MANAGED] !== "true") {
                    const error = new Error("not_managed");
                    error.statusCode = 403;
                    throw error;
                }
            }
            catch (error) {
                const statusCode = error.statusCode;
                if (statusCode === 404) {
                    const missing = new Error("not_found");
                    missing.statusCode = 404;
                    throw missing;
                }
                if (statusCode === 403 || statusCode === 400)
                    throw error;
                // inspect can fail if volume vanished; still attempt remove
            }
            try {
                await docker.getVolume(volumeName).remove({ force: false });
            }
            catch (error) {
                const statusCode = error.statusCode;
                if (statusCode === 404)
                    return;
                if (statusCode === 409) {
                    const busy = new Error("volume_in_use");
                    busy.statusCode = 409;
                    throw busy;
                }
                throw error;
            }
        },
        async pullImages(images, onProgress) {
            const results = [];
            for (const image of images) {
                try {
                    onProgress?.({ image, status: "Pulling", detail: `Starting ${image}` });
                    await pullOneImage(docker, image, onProgress);
                    onProgress?.({ image, status: "complete", percent: 100, detail: "Pull complete" });
                    results.push({ image, ok: true });
                }
                catch (error) {
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
    };
}
//# sourceMappingURL=container-runtime.js.map