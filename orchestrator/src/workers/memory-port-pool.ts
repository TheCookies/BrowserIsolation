import type { PortPool } from "../port-pool";

export type MemoryPortPool = PortPool & {
  /** Mark a port as in-use without allocating (for reclaim after restart). */
  reserve(port: number): void;
};

/** In-process port allocator for a worker agent (ports freed on release). */
export function createMemoryPortPool(start: number, end: number): MemoryPortPool {
  const used = new Set<number>();

  return {
    isInRange(port) {
      return Number.isInteger(port) && port >= start && port <= end;
    },

    allocate() {
      for (let port = start; port <= end; port += 1) {
        if (!used.has(port)) {
          used.add(port);
          return port;
        }
      }
      throw new Error("webrtc_port_pool_exhausted");
    },

    reserve(port) {
      if (this.isInRange(port)) used.add(port);
    },

    release(port) {
      used.delete(port);
    },
  };
}
