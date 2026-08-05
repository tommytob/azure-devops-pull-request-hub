/**
 * Caches the derived per-pull-request data the hub displays, so a reload does
 * not repeat four requests per pull request.
 *
 * What is deliberately *not* cached: reviewer votes, draft flag and merge
 * status. Those arrive with the pull request list itself, which is always
 * fetched fresh - and they are what the status column leans on most.
 *
 * Two buckets with their own lifetimes, because they age differently. Policies
 * are what someone watches while waiting for a build, so they go stale fast;
 * comments, labels and work items move slowly.
 *
 * A changed commit invalidates both regardless of age, which covers pushes
 * immediately. Nothing covers a new comment or a rerun build, hence the
 * lifetimes - and the refresh button bypasses the cache entirely.
 */
const CACHE_KEY_PREFIX = "prmh_pr_cache_";

/** Bump when the cached shape changes, so old entries are ignored rather than misread. */
const CACHE_VERSION = 2;

export const SLOW_BUCKET_LIFETIME_MS = 15 * 60 * 1000;
export const POLICY_BUCKET_LIFETIME_MS = 3 * 60 * 1000;

/**
 * One bucket per loader rather than one per lifetime. Each loader writes its own
 * bucket from its own success path, so a call that fails writes nothing at all -
 * there is no way to persist an empty result from a failed request, which would
 * otherwise look like real data for the next quarter of an hour.
 */
export type CacheBucket = "details" | "threads" | "workItems" | "policies";

interface CacheEntry<T> {
  version: number;
  commitId: string;
  storedAt: number;
  payload: T;
}

const lifetimeFor = (bucket: CacheBucket): number =>
  bucket === "policies" ? POLICY_BUCKET_LIFETIME_MS : SLOW_BUCKET_LIFETIME_MS;

const keyFor = (bucket: CacheBucket, pullRequestId: number): string =>
  `${CACHE_KEY_PREFIX}${bucket}_${pullRequestId}`;

/**
 * Some browsers, and some corporate policies, block localStorage outright -
 * index.tsx already warns about it. Every operation here degrades to a miss
 * rather than throwing.
 */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked, or the quota is full. A cache that cannot store is still correct.
  }
}

export function readCache<T>(
  bucket: CacheBucket,
  pullRequestId: number,
  commitId: string,
  now: number = Date.now()
): T | undefined {
  const raw = safeGet(keyFor(bucket, pullRequestId));

  if (raw === null) {
    return undefined;
  }

  let entry: CacheEntry<T>;

  try {
    entry = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (entry === null || typeof entry !== "object") {
    return undefined;
  }

  if (entry.version !== CACHE_VERSION) {
    return undefined;
  }

  if (entry.commitId !== commitId) {
    return undefined;
  }

  if (now - entry.storedAt >= lifetimeFor(bucket)) {
    return undefined;
  }

  return entry.payload;
}

export function writeCache<T>(
  bucket: CacheBucket,
  pullRequestId: number,
  commitId: string,
  payload: T,
  now: number = Date.now()
): void {
  const entry: CacheEntry<T> = {
    version: CACHE_VERSION,
    commitId,
    storedAt: now,
    payload,
  };

  safeSet(keyFor(bucket, pullRequestId), JSON.stringify(entry));
}

/** Drops every cached pull request, for the refresh button and for tests. */
export function clearCache(): void {
  try {
    const keys: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);

      if (key !== null && key.startsWith(CACHE_KEY_PREFIX)) {
        keys.push(key);
      }
    }

    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Nothing stored means nothing to clear.
  }
}
