import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HostDiskMetrics = {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
};

export type HostNetworkInterface = {
  name: string;
  state: string | null;
  /** Negotiated link speed in Mbps; null if unknown (common in containers/VMs). */
  linkMbps: number | null;
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  /** Rough link utilization when speed is known; null otherwise. */
  utilizationPercent: number | null;
};

export type HostMetrics = {
  collectedAt: string;
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    model: string | null;
    load1: number;
    load5: number;
    load15: number;
    /** Approximate busy percent over a short sample window; null if unavailable. */
    usagePercent: number | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  disks: HostDiskMetrics[];
  network: {
    sampleMs: number;
    interfaces: HostNetworkInterface[];
  };
};

type NetCounters = Map<string, { rxBytes: number; txBytes: number }>;

function readMeminfo(): { total: number; available: number } | null {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/m.exec(text);
    const availMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    if (!totalMatch || !availMatch) return null;
    return {
      total: Number(totalMatch[1]) * 1024,
      available: Number(availMatch[1]) * 1024,
    };
  } catch {
    return null;
  }
}

function readCpuTimes(): { idle: number; total: number } | null {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
    if (!line.startsWith("cpu ")) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) return null;
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function readNetDev(): NetCounters {
  const counters: NetCounters = new Map();
  try {
    const text = readFileSync("/proc/net/dev", "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      const name = trimmed.slice(0, colon).trim();
      if (!name || name === "lo") continue;
      const parts = trimmed.slice(colon + 1).trim().split(/\s+/).map(Number);
      if (parts.length < 16 || parts.some((value) => !Number.isFinite(value))) continue;
      counters.set(name, { rxBytes: parts[0]!, txBytes: parts[8]! });
    }
  } catch {
    /* ignore */
  }
  return counters;
}

async function readIfaceMeta(
  name: string,
): Promise<{ state: string | null; linkMbps: number | null }> {
  const base = path.join("/sys/class/net", name);
  let state: string | null = null;
  let linkMbps: number | null = null;
  try {
    state = (await readFile(path.join(base, "operstate"), "utf8")).trim() || null;
  } catch {
    /* ignore */
  }
  try {
    const raw = (await readFile(path.join(base, "speed"), "utf8")).trim();
    const speed = Number(raw);
    if (Number.isFinite(speed) && speed > 0) linkMbps = speed;
  } catch {
    /* ignore — often unavailable in containers */
  }
  return { state, linkMbps };
}

function listCandidateIfaces(counters: NetCounters): string[] {
  let names = [...counters.keys()];
  if (names.length === 0 && existsSync("/sys/class/net")) {
    try {
      names = readdirSync("/sys/class/net").filter((name) => name !== "lo");
    } catch {
      names = [];
    }
  }
  // Prefer physical / primary interfaces first; keep virtual ones after.
  const rank = (name: string): number => {
    if (/^eth\d|^ens\d|^enp\d|^eno\d|^wlan\d/.test(name)) return 0;
    if (name.startsWith("br-") || name.startsWith("docker") || name.startsWith("veth")) return 2;
    return 1;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

async function sampleCpuAndNetwork(sampleMs = 200): Promise<{
  usagePercent: number | null;
  network: HostNetworkInterface[];
  sampleMs: number;
}> {
  const cpuFirst = readCpuTimes();
  const netFirst = readNetDev();
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const elapsedMs = Math.max(1, Date.now() - started);
  const cpuSecond = readCpuTimes();
  const netSecond = readNetDev();

  let usagePercent: number | null = null;
  if (cpuFirst && cpuSecond) {
    const idleDelta = cpuSecond.idle - cpuFirst.idle;
    const totalDelta = cpuSecond.total - cpuFirst.total;
    if (totalDelta > 0) {
      const busy = 1 - idleDelta / totalDelta;
      usagePercent = Math.max(0, Math.min(100, Math.round(busy * 1000) / 10));
    }
  }

  const names = listCandidateIfaces(netSecond.size > 0 ? netSecond : netFirst);
  const interfaces: HostNetworkInterface[] = [];
  for (const name of names.slice(0, 8)) {
    const after = netSecond.get(name) ?? { rxBytes: 0, txBytes: 0 };
    const before = netFirst.get(name);
    const meta = await readIfaceMeta(name);
    let rxBytesPerSec: number | null = null;
    let txBytesPerSec: number | null = null;
    let utilizationPercent: number | null = null;
    if (before) {
      const seconds = elapsedMs / 1000;
      rxBytesPerSec = Math.max(0, Math.round((after.rxBytes - before.rxBytes) / seconds));
      txBytesPerSec = Math.max(0, Math.round((after.txBytes - before.txBytes) / seconds));
      if (meta.linkMbps && meta.linkMbps > 0) {
        const bitsPerSec = (rxBytesPerSec + txBytesPerSec) * 8;
        const capacity = meta.linkMbps * 1_000_000;
        utilizationPercent = Math.max(
          0,
          Math.min(100, Math.round((bitsPerSec / capacity) * 1000) / 10),
        );
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

async function diskForPath(mountPath: string): Promise<HostDiskMetrics | null> {
  try {
    const stats = await statfs(mountPath);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return {
      path: mountPath,
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
    };
  } catch {
    return null;
  }
}

export async function collectHostMetrics(
  diskPaths: string[] = ["/", "/data", "/var/lib/docker"],
): Promise<HostMetrics> {
  const [sampled, ...diskResults] = await Promise.all([
    sampleCpuAndNetwork(),
    ...diskPaths.map((pathName) => diskForPath(pathName)),
  ]);

  const meminfo = readMeminfo();
  const totalBytes = meminfo?.total ?? os.totalmem();
  const availableBytes = meminfo?.available ?? os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const load = os.loadavg();
  const cpus = os.cpus();

  const disks: HostDiskMetrics[] = [];
  const seen = new Set<string>();
  for (const disk of diskResults) {
    if (!disk) continue;
    const key = `${disk.totalBytes}:${disk.availableBytes}`;
    if (seen.has(key) && disk.path !== "/") continue;
    seen.add(key);
    disks.push(disk);
  }
  if (disks.length === 0) {
    const root = await diskForPath("/");
    if (root) disks.push(root);
  }

  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      cores: cpus.length || os.availableParallelism?.() || 1,
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
