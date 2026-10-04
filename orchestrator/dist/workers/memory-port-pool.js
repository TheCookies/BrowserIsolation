"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemoryPortPool = createMemoryPortPool;
/** In-process port allocator for a worker agent (ports freed on release). */
function createMemoryPortPool(start, end) {
    const used = new Set();
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
            if (this.isInRange(port))
                used.add(port);
        },
        release(port) {
            used.delete(port);
        },
    };
}
//# sourceMappingURL=memory-port-pool.js.map