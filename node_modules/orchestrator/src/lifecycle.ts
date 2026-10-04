import type { BrowserSessionRecord, BrowserSessionStore } from "./browser-session-store";
import type { Config } from "./config";
import { LABEL_BROWSER, LABEL_OWNER, LABEL_SESSION } from "./docker/labels";
import type { ViewerTracker } from "./viewer-tracker";
import type { WorkerPlacement } from "./workers/placement";

export type LifecycleDeps = {
  config: Config;
  store: BrowserSessionStore;
  placement: WorkerPlacement;
  viewers: ViewerTracker;
};

export type ReconcileSummary = {
  adopted: number;
  removedOrphanContainers: number;
  removedStaleSessions: number;
};

export type ReaperSummary = {
  destroyedIdle: number;
  destroyedExpired: number;
};

type Logger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

async function destroySession(
  deps: LifecycleDeps,
  session: BrowserSessionRecord,
  reason: string,
  log?: Logger,
): Promise<void> {
  log?.info(
    { sessionId: session.id, owner: session.ownerUsername, reason, workerId: session.workerId },
    "destroying browser session",
  );
  try {
    await deps.placement.remove(session.workerId, session.containerId);
  } catch (error) {
    log?.warn({ err: error, sessionId: session.id }, "container remove failed during destroy");
  }
  deps.store.delete(session.id);
}

/**
 * Align SQLite browser_sessions with managed containers across all workers.
 */
export async function reconcileBrowserSessions(
  deps: LifecycleDeps,
  log?: Logger,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    adopted: 0,
    removedOrphanContainers: 0,
    removedStaleSessions: 0,
  };

  const managed = await deps.placement.listManagedAll();
  const bySessionId = new Map<string, (typeof managed)[number]>();
  for (const container of managed) {
    const sessionId = container.labels[LABEL_SESSION];
    if (sessionId) bySessionId.set(sessionId, container);
  }

  for (const session of deps.store.list()) {
    const labeled = bySessionId.get(session.id);
    if (labeled?.running) {
      if (labeled.id !== session.containerId || labeled.name !== session.containerName) {
        deps.store.updateContainer(session.id, {
          containerId: labeled.id,
          containerName: labeled.name,
        });
        summary.adopted += 1;
        log?.info(
          { sessionId: session.id, containerId: labeled.id, workerId: labeled.workerId },
          "adopted running managed container",
        );
      }
      bySessionId.delete(session.id);
      continue;
    }

    if (labeled) {
      await deps.placement.remove(labeled.workerId, labeled.id).catch(() => undefined);
      bySessionId.delete(session.id);
    } else {
      await deps.placement.remove(session.workerId, session.containerId).catch(() => undefined);
    }
    deps.store.delete(session.id);
    summary.removedStaleSessions += 1;
    log?.info({ sessionId: session.id }, "removed stale browser session without running container");
  }

  for (const orphan of bySessionId.values()) {
    await deps.placement.remove(orphan.workerId, orphan.id).catch(() => undefined);
    summary.removedOrphanContainers += 1;
    log?.info(
      {
        containerId: orphan.id,
        workerId: orphan.workerId,
        sessionId: orphan.labels[LABEL_SESSION],
        owner: orphan.labels[LABEL_OWNER],
        browser: orphan.labels[LABEL_BROWSER],
      },
      "removed orphan managed container",
    );
  }

  return summary;
}

export async function reapBrowserSessions(
  deps: LifecycleDeps,
  now = Date.now(),
  log?: Logger,
): Promise<ReaperSummary> {
  const summary: ReaperSummary = { destroyedIdle: 0, destroyedExpired: 0 };
  const idleMs = deps.config.idleTimeoutMinutes * 60_000;
  const maxMs = deps.config.maxSessionHours * 60 * 60_000;

  for (const session of deps.store.list()) {
    if (now - session.createdAt >= maxMs) {
      await destroySession(deps, session, "max_session_hours", log);
      summary.destroyedExpired += 1;
      continue;
    }

    const viewerCount = deps.viewers.count(session.id);
    if (viewerCount > 0) {
      deps.store.touch(session.id, now);
      continue;
    }

    if (now - session.lastActivityAt >= idleMs) {
      await destroySession(deps, session, "idle_timeout", log);
      summary.destroyedIdle += 1;
    }
  }

  return summary;
}

export function startBrowserReaper(
  deps: LifecycleDeps,
  log: Logger,
): { stop: () => void; runOnce: () => Promise<ReaperSummary> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const runOnce = async () => {
    if (running) {
      return { destroyedIdle: 0, destroyedExpired: 0 };
    }
    running = true;
    try {
      const summary = await reapBrowserSessions(deps, Date.now(), log);
      if (summary.destroyedIdle || summary.destroyedExpired) {
        log.info(summary, "reaper pass complete");
      }
      return summary;
    } catch (error) {
      log.error({ err: error }, "reaper pass failed");
      return { destroyedIdle: 0, destroyedExpired: 0 };
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    timer = setTimeout(() => {
      void runOnce().finally(() => {
        if (!stopped) schedule();
      });
    }, deps.config.reaperIntervalSeconds * 1000);
    timer.unref?.();
  };

  schedule();
  log.info(
    {
      intervalSeconds: deps.config.reaperIntervalSeconds,
      idleTimeoutMinutes: deps.config.idleTimeoutMinutes,
      maxSessionHours: deps.config.maxSessionHours,
    },
    "browser session reaper started",
  );

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce,
  };
}
