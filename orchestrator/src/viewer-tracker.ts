/** Counts active proxied WebSocket viewers per browser session. */
export type ViewerTracker = {
  join(sessionId: string): () => void;
  count(sessionId: string): number;
};

export function createViewerTracker(): ViewerTracker {
  const counts = new Map<string, number>();

  return {
    join(sessionId) {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const next = (counts.get(sessionId) ?? 1) - 1;
        if (next <= 0) counts.delete(sessionId);
        else counts.set(sessionId, next);
      };
    },

    count(sessionId) {
      return counts.get(sessionId) ?? 0;
    },
  };
}
