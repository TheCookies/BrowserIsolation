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

  return {
    isInRange(port) {
      return Number.isInteger(port) && port >= start && port <= end;
    },

    allocate() {
      const used = new Set(usedStmt.all(workerId).map((row) => row.port));
      for (let port = start; port <= end; port += 1) {
        if (!used.has(port)) return port;
      }
      throw new Error("webrtc_port_pool_exhausted");
    },

    release(_port) {
      // Ports are freed when the browser_sessions row is deleted.
    },
  };
}
