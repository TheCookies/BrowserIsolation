import type Database from "better-sqlite3";

export type PortPool = {
  allocate(): number;
  release(port: number): void;
  isInRange(port: number): boolean;
};

export function createPortPool(
  db: Database.Database,
  start: number,
  end: number,
  /** Limit to one worker's sessions (local host pool). */
  workerId = "local",
): PortPool {
  const usedStmt = db.prepare<[string], { port: number }>(
    `SELECT webrtc_port AS port FROM browser_sessions WHERE worker_id = ?`,
  );
  // Session rows are inserted only after the container is up. Without this set,
  // overlapping launches all read the same free port and the later containers
  // fail to bind (only the first browser comes up).
  const reserved = new Set<number>();

  return {
    isInRange(port) {
      return Number.isInteger(port) && port >= start && port <= end;
    },

    allocate() {
      const used = new Set(usedStmt.all(workerId).map((row) => row.port));
      for (const port of reserved) used.add(port);
      for (let port = start; port <= end; port += 1) {
        if (!used.has(port)) {
          reserved.add(port);
          return port;
        }
      }
      throw new Error("webrtc_port_pool_exhausted");
    },

    release(port) {
      // Drop the in-flight hold. A committed browser_sessions row still occupies
      // the port until that row is deleted.
      reserved.delete(port);
    },
  };
}
