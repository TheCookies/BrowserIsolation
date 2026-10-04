"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createViewerTracker = createViewerTracker;
function createViewerTracker() {
    const counts = new Map();
    return {
        join(sessionId) {
            counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
            let left = false;
            return () => {
                if (left)
                    return;
                left = true;
                const next = (counts.get(sessionId) ?? 1) - 1;
                if (next <= 0)
                    counts.delete(sessionId);
                else
                    counts.set(sessionId, next);
            };
        },
        count(sessionId) {
            return counts.get(sessionId) ?? 0;
        },
    };
}
//# sourceMappingURL=viewer-tracker.js.map