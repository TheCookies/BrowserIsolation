/** Run at most `max` async jobs at once. Slots free when the job finishes, not when the browser session ends. */
export function createConcurrencyLimit(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}
