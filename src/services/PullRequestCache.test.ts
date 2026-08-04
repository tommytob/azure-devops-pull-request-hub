import {
  clearCache,
  POLICY_BUCKET_LIFETIME_MS,
  readCache,
  SLOW_BUCKET_LIFETIME_MS,
  writeCache,
} from "./PullRequestCache";

const PR = 1862;
const COMMIT = "abc123";
const NOW = 1_770_000_000_000;

beforeEach(() => {
  localStorage.clear();
});

it("returns what was stored while the entry is fresh", () => {
  writeCache("threads", PR, COMMIT, { totalcomment: 7 }, NOW);

  expect(readCache("threads", PR, COMMIT, NOW + 1000)).toEqual({
    totalcomment: 7,
  });
});

it("misses when nothing was stored", () => {
  expect(readCache("threads", PR, COMMIT, NOW)).toBeUndefined();
});

it("misses once the commit changed, however fresh the entry is", () => {
  writeCache("threads", PR, COMMIT, { totalcomment: 7 }, NOW);

  expect(readCache("threads", PR, "a-new-commit", NOW + 1000)).toBeUndefined();
});

it("misses once a slow bucket has aged out", () => {
  writeCache("threads", PR, COMMIT, { totalcomment: 7 }, NOW);

  expect(
    readCache("threads", PR, COMMIT, NOW + SLOW_BUCKET_LIFETIME_MS - 1)
  ).toEqual({ totalcomment: 7 });
  expect(
    readCache("threads", PR, COMMIT, NOW + SLOW_BUCKET_LIFETIME_MS)
  ).toBeUndefined();
});

it("ages policies out sooner than the slow buckets", () => {
  writeCache("policies", PR, COMMIT, { isAllPoliciesOk: true }, NOW);

  expect(
    readCache("policies", PR, COMMIT, NOW + POLICY_BUCKET_LIFETIME_MS - 1)
  ).toEqual({ isAllPoliciesOk: true });
  expect(
    readCache("policies", PR, COMMIT, NOW + POLICY_BUCKET_LIFETIME_MS)
  ).toBeUndefined();
  expect(POLICY_BUCKET_LIFETIME_MS).toBeLessThan(SLOW_BUCKET_LIFETIME_MS);
});

it("keeps the buckets apart", () => {
  writeCache("threads", PR, COMMIT, { a: 1 }, NOW);
  writeCache("policies", PR, COMMIT, { b: 2 }, NOW);

  expect(readCache("threads", PR, COMMIT, NOW)).toEqual({ a: 1 });
  expect(readCache("policies", PR, COMMIT, NOW)).toEqual({ b: 2 });
});

it("keeps pull requests apart", () => {
  writeCache("threads", PR, COMMIT, { a: 1 }, NOW);

  expect(readCache("threads", 9999, COMMIT, NOW)).toBeUndefined();
});

it("misses on stored junk rather than throwing", () => {
  localStorage.setItem(`prmh_pr_cache_threads_${PR}`, "not json");

  expect(readCache("threads", PR, COMMIT, NOW)).toBeUndefined();
});

it("misses on an entry from an older cache version", () => {
  localStorage.setItem(
    `prmh_pr_cache_threads_${PR}`,
    JSON.stringify({
      version: 0,
      commitId: COMMIT,
      storedAt: NOW,
      payload: { a: 1 },
    })
  );

  expect(readCache("threads", PR, COMMIT, NOW)).toBeUndefined();
});

it("clears its own keys and leaves other storage alone", () => {
  writeCache("threads", PR, COMMIT, { a: 1 }, NOW);
  writeCache("policies", PR, COMMIT, { b: 2 }, NOW);
  localStorage.setItem("prmh-current-filter", "keep me");

  clearCache();

  expect(readCache("threads", PR, COMMIT, NOW)).toBeUndefined();
  expect(readCache("policies", PR, COMMIT, NOW)).toBeUndefined();
  expect(localStorage.getItem("prmh-current-filter")).toBe("keep me");
});

describe("when localStorage is blocked", () => {
  const original = window.localStorage;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked by policy");
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: original,
    });
  });

  it("reads as a miss instead of throwing", () => {
    expect(() => readCache("threads", PR, COMMIT, NOW)).not.toThrow();
    expect(readCache("threads", PR, COMMIT, NOW)).toBeUndefined();
  });

  it("writes without throwing", () => {
    expect(() => writeCache("threads", PR, COMMIT, { a: 1 }, NOW)).not.toThrow();
  });

  it("clears without throwing", () => {
    expect(() => clearCache()).not.toThrow();
  });
});
