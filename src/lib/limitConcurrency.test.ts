import { createLimiter } from "./limitConcurrency";

/** A task that resolves only when told to, so concurrency can be observed. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

/**
 * Tasks start one microtask after limit() is called, because the limiter routes
 * them through Promise.resolve().then to catch synchronous throws. Flush the
 * queue before asserting on what is running.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("never runs more than the limit at once", async () => {
  const limit = createLimiter(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  let active = 0;
  let peak = 0;

  const runs = gates.map((gate) =>
    limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
    })
  );

  await flush();

  expect(peak).toBe(2);

  gates.forEach((gate) => gate.release());
  await Promise.all(runs);

  expect(peak).toBe(2);
});

it("starts a queued task as soon as a slot frees up", async () => {
  const limit = createLimiter(1);
  const first = deferred();
  const started: string[] = [];

  const a = limit(async () => {
    started.push("a");
    await first.promise;
  });
  const b = limit(async () => {
    started.push("b");
  });

  await flush();

  expect(started).toEqual(["a"]);

  first.release();
  await Promise.all([a, b]);

  expect(started).toEqual(["a", "b"]);
});

it("resolves with the task's own value", async () => {
  const limit = createLimiter(2);

  await expect(limit(async () => 42)).resolves.toBe(42);
});

it("rejects with the task's error and still frees the slot", async () => {
  const limit = createLimiter(1);

  await expect(limit(async () => Promise.reject(new Error("nope")))).rejects.toThrow(
    "nope"
  );

  // The slot must be free again, otherwise one failure stalls everything after it.
  await expect(limit(async () => "after")).resolves.toBe("after");
});

it("frees the slot when a task throws synchronously", async () => {
  const limit = createLimiter(1);

  await expect(
    limit((() => {
      throw new Error("sync");
    }) as () => Promise<never>)
  ).rejects.toThrow("sync");

  await expect(limit(async () => "after")).resolves.toBe("after");
});

it("runs everything given to it, beyond the limit", async () => {
  const limit = createLimiter(3);
  const order: number[] = [];

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      limit(async () => {
        order.push(i);
      })
    )
  );

  expect(order).toHaveLength(20);
  expect(new Set(order).size).toBe(20);
});

it("refuses a limit below one, which would deadlock", () => {
  expect(() => createLimiter(0)).toThrow();
});
