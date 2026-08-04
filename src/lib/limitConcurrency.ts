/**
 * Bounds how many async tasks run at once.
 *
 * Every PullRequestModel fires five requests from its constructor, and the tab
 * constructs one model per pull request in a single loop - so a few hundred
 * pull requests put well over a thousand fetches in flight in one tick. Azure
 * DevOps and the browser both give up under that, and the failures are silent:
 * the callers catch, log and carry on, leaving those rows without labels or
 * work items.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(max: number): Limiter {
  if (max < 1) {
    throw new Error(`A limiter needs to allow at least one task, got ${max}`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  const startNext = (): void => {
    if (active >= max) {
      return;
    }

    const start = waiting.shift();

    if (start === undefined) {
      return;
    }

    active++;
    start();
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        // Promise.resolve().then(task) rather than task() so a task that throws
        // synchronously rejects instead of escaping the queue and stalling it.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            startNext();
          });
      });

      startNext();
    });
  };
}
