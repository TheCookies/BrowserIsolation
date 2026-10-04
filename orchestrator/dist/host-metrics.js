"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectHostMetrics = collectHostMetrics;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function readMeminfo() {
    try {
        const text = (0, node_fs_1.readFileSync)("/proc/meminfo", "utf8");
        const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/m.exec(text);
        const availMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
        if (!totalMatch || !availMatch)
            return null;
        return {
            total: Number(totalMatch[1]) * 1024,
            available: Number(availMatch[1]) * 1024,
        };
    }
    catch {
        return null;
    }
}
function readCpuTimes() {
    try {
        const line = (0, node_fs_1.readFileSync)("/proc/stat", "utf8").split("\n")[0] ?? "";
        if (!line.startsWith("cpu "))
            return null;
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4 || parts.some((value) => !Number.isFinite(value)))
            return null;
        const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
        const total = parts.reduce((sum, value) => sum + value, 0);
        return { idle, total };
    }
    catch {
        return null;
    }
}
function readNetDev() {
    const counters = new Map();
    try {
        const text = (0, node_fs_1.readFileSync)("/proc/net/dev", "utf8");
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            const colon = trimmed.indexOf(":");
            if (colon <= 0)
                continue;
            const name = trimmed.slice(0, colon).trim();
            if (!name || name === "lo")
                continue;
            const parts = trimmed.slice(colon + 1).trim().split(/\s+/).map(Number);
            if (parts.length < 16 || parts.some((value) => !Number.isFinite(value)))
                continue;
            counters.set(name, { rxBytes: parts[0], txBytes: parts[8] });
        }
    }
    catch {
        /* ignore */
    }
    return counters;
}
async function readIfaceMeta(name) {
    const base = node_path_1.default.join("/sys/class/net", name);
    let state = null;
    let linkMbps = null;
    try {
        state = (await (0, promises_1.readFile)(node_path_1.default.join(base, "operstate"), "utf8")).trim() || null;
    }
    catch {
        /* ignore */
    }
    try {
        const raw = (await (0, promises_1.readFile)(node_path_1.default.join(base, "speed"), "utf8")).trim();
        const speed = Number(raw);
        if (Number.isFinite(speed) && speed > 0)
            linkMbps = speed;
    }
    catch {
        /* ignore — often unavailable in containers */
    }
    return { state, linkMbps };
}
function listCandidateIfaces(counters) {
    let names = [...counters.keys()];
    if (names.length === 0 && (0, node_fs_1.existsSync)("/sys/class/net")) {
        try {
            names = (0, node_fs_1.readdirSync)("/sys/class/net").filter((name) => name !== "lo");
        }
        catch {
            names = [];
        }
    }
    // Prefer physical / primary interfaces first; keep virtual ones after.
    const rank = (name) => {
        if (/^eth\d|^ens\d|^enp\d|^eno\d|^wlan\d/.test(name))
            return 0;
        if (name.startsWith("br-") || name.startsWith("docker") || name.startsWith("veth"))
            return 2;
        return 1;
    };
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
async function sampleCpuAndNetwork(sampleMs = 200) {
    const cpuFirst = readCpuTimes();
    const netFirst = readNetDev();
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
    const elapsedMs = Math.max(1, Date.now() - started);
    const cpuSecond = readCpuTimes();
    const netSecond = readNetDev();
    let usagePercent = null;
    if (cpuFirst && cpuSecond) {
        const idleDelta = cpuSecond.idle - cpuFirst.idle;
        const totalDelta = cpuSecond.total - cpuFirst.total;
        if (totalDelta > 0) {
            const busy = 1 - idleDelta / totalDelta;
            usagePercent = Math.max(0, Math.min(100, Math.round(busy * 1000) / 10));
        }
    }
    const names = listCandidateIfaces(netSecond.size > 0 ? netSecond : netFirst);
    const interfaces = [];
    for (const name of names.slice(0, 8)) {
        const after = netSecond.get(name) ?? { rxBytes: 0, txBytes: 0 };
        const before = netFirst.get(name);
        const meta = await readIfaceMeta(name);
        let rxBytesPerSec = null;
        let txBytesPerSec = null;
        let utilizationPercent = null;
        if (before) {
            const seconds = elapsedMs / 1000;
            rxBytesPerSec = Math.max(0, Math.round((after.rxBytes - before.rxBytes) / seconds));
            txBytesPerSec = Math.max(0, Math.round((after.txBytes - before.txBytes) / seconds));
            if (meta.linkMbps && meta.linkMbps > 0) {
                const bitsPerSec = (rxBytesPerSec + txBytesPerSec) * 8;
                const capacity = meta.linkMbps * 1_000_000;
                utilizationPercent = Math.max(0, Math.min(100, Math.round((bitsPerSec / capacity) * 1000) / 10));
            }
        }
        interfaces.push({
            name,
            state: meta.state,
            linkMbps: meta.linkMbps,
            rxBytes: after.rxBytes,
            txBytes: after.txBytes,
            rxBytesPerSec,
            txBytesPerSec,
            utilizationPercent,
        });
    }
    return { usagePercent, network: interfaces, sampleMs: elapsedMs };
}
async function diskForPath(mountPath) {
    try {
        const stats = await (0, promises_1.statfs)(mountPath);
        const totalBytes = Number(stats.blocks) * Number(stats.bsize);
        const availableBytes = Number(stats.bavail) * Number(stats.bsize);
        if (!Number.isFinite(totalBytes) || totalBytes <= 0)
            return null;
        const usedBytes = Math.max(0, totalBytes - availableBytes);
        return {
            path: mountPath,
            totalBytes,
            usedBytes,
            availableBytes,
            usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
        };
    }
    catch {
        return null;
    }
}
async function collectHostMetrics(diskPaths = ["/", "/data", "/var/lib/docker"]) {
    const [sampled, ...diskResults] = await Promise.all([
        sampleCpuAndNetwork(),
        ...diskPaths.map((pathName) => diskForPath(pathName)),
    ]);
    const meminfo = readMeminfo();
    const totalBytes = meminfo?.total ?? node_os_1.default.totalmem();
    const availableBytes = meminfo?.available ?? node_os_1.default.freemem();
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const load = node_os_1.default.loadavg();
    const cpus = node_os_1.default.cpus();
    const disks = [];
    const seen = new Set();
    for (const disk of diskResults) {
        if (!disk)
            continue;
        const key = `${disk.totalBytes}:${disk.availableBytes}`;
        if (seen.has(key) && disk.path !== "/")
            continue;
        seen.add(key);
        disks.push(disk);
    }
    if (disks.length === 0) {
        const root = await diskForPath("/");
        if (root)
            disks.push(root);
    }
    return {
        collectedAt: new Date().toISOString(),
        hostname: node_os_1.default.hostname(),
        platform: `${node_os_1.default.type()} ${node_os_1.default.release()}`,
        uptimeSeconds: Math.round(node_os_1.default.uptime()),
        cpu: {
            cores: cpus.length || node_os_1.default.availableParallelism?.() || 1,
            model: cpus[0]?.model?.trim() || null,
            load1: Math.round((load[0] ?? 0) * 100) / 100,
            load5: Math.round((load[1] ?? 0) * 100) / 100,
            load15: Math.round((load[2] ?? 0) * 100) / 100,
            usagePercent: sampled.usagePercent,
        },
        memory: {
            totalBytes,
            usedBytes,
            availableBytes,
            usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
        },
        disks,
        network: {
            sampleMs: sampled.sampleMs,
            interfaces: sampled.network,
        },
    };
}
//# sourceMappingURL=host-metrics.js.map