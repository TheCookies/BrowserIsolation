import type { WorkerStore } from "./store";
import type { WorkerRecord } from "./types";

const ONLINE_TTL_MS = 45_000;

export function isWorkerOnline(worker: WorkerRecord, now = Date.now()): boolean {
  if (!worker.enabled) return false;
  if (worker.kind === "local") return true;
  if (worker.lastSeenAt === null) return false;
  return now - worker.lastSeenAt <= ONLINE_TTL_MS;
}

/**
 * Pick a worker for a new browser session.
 * Prefers stickyWorkerId when online; otherwise least activeSessions among online workers.
 */
export function pickWorker(
  workers: WorkerRecord[],
  options?: { stickyWorkerId?: string | null; now?: number },
): WorkerRecord | null {
  const now = options?.now ?? Date.now();
  const online = workers.filter((worker) => isWorkerOnline(worker, now));
  if (online.length === 0) return null;

  const sticky = options?.stickyWorkerId;
  if (sticky) {
    const preferred = online.find((worker) => worker.id === sticky);
    if (preferred) return preferred;
  }

  const sorted = [...online].sort((a, b) => {
    if (a.activeSessions !== b.activeSessions) {
      return a.activeSessions - b.activeSessions;
    }
    return a.id.localeCompare(b.id);
  });
  return sorted[0] ?? null;
}

export function createWorkerPoller(deps: {
  store: WorkerStore;
  pollRemote: (worker: WorkerRecord) => Promise<{ activeSessions: number; publicIp: string }>;
  intervalMs?: number;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): { stop: () => void; runOnce: () => Promise<void> } {
  const intervalMs = deps.intervalMs ?? 15_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      for (const worker of deps.store.list()) {
        if (!worker.enabled || worker.kind === "local") continue;
        try {
          const status = await deps.pollRemote(worker);
          deps.store.touchStatus(worker.id, {
            lastSeenAt: Date.now(),
            activeSessions: status.activeSessions,
            publicIp: status.publicIp,
          });
        } catch (error) {
          // Auth/token failures must take the worker offline immediately; otherwise a
          // stale lastSeenAt keeps it selectable and launch fails with "unauthorized".
          deps.store.markUnseen(worker.id);
          deps.log?.warn({ err: error, workerId: worker.id }, "worker poll failed");
        }
      }
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    timer = setTimeout(() => {
      void runOnce().finally(() => {
        if (!stopped) schedule();
      });
    }, intervalMs);
    timer.unref?.();
  };

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce,
  };
}

export { ONLINE_TTL_MS };
