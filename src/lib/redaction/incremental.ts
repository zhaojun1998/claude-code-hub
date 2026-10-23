/**
 * Incremental finding tracker.
 *
 * Conversations are re-sent in full on every turn, so a value that was redacted in turn 1
 * is redacted again in every later request. Redaction itself must still happen on every
 * request, but the usage log should only show findings from content that is new in this
 * request. A finding is identified by the fingerprint of the string it lives in plus its
 * offset and value; each session (or API key when there is no session) remembers the
 * findings it has already reported. After a context compaction the summary is new text, so
 * values inside it are reported again.
 */

import { createHash } from "node:crypto";
import type { BodyRedaction } from "./types";

export interface SeenStore {
  /** Adds keys to the scope and returns the subset that was not present before. */
  addNew(scope: string, keys: string[], ttlSeconds: number): Promise<Set<string>>;
}

export function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function findingKey(
  redaction: Pick<BodyRedaction, "segmentFingerprint" | "start" | "original">
) {
  return createHash("sha256")
    .update(redaction.segmentFingerprint)
    .update("\u0000")
    .update(String(redaction.start))
    .update("\u0000")
    .update(redaction.original)
    .digest("hex")
    .slice(0, 24);
}

export function scopeKey(scope: string): string {
  return `cch:redaction:seen:${createHash("sha256").update(scope).digest("hex").slice(0, 32)}`;
}

interface MemoryScope {
  keys: Set<string>;
  expiresAt: number;
}

/** In-process fallback used when Redis is not configured or fails. */
export class MemorySeenStore implements SeenStore {
  private readonly scopes = new Map<string, MemoryScope>();

  constructor(
    private readonly maxScopes = 2_000,
    private readonly maxKeysPerScope = 20_000,
    private readonly now: () => number = Date.now
  ) {}

  async addNew(scope: string, keys: string[], ttlSeconds: number): Promise<Set<string>> {
    const current = this.now();
    let entry = this.scopes.get(scope);
    if (entry && entry.expiresAt <= current) {
      this.scopes.delete(scope);
      entry = undefined;
    }
    if (!entry) {
      if (this.scopes.size >= this.maxScopes) {
        const oldest = this.scopes.keys().next().value;
        if (oldest !== undefined) this.scopes.delete(oldest);
      }
      entry = { keys: new Set(), expiresAt: 0 };
    } else {
      // Refresh LRU order.
      this.scopes.delete(scope);
    }
    entry.expiresAt = current + ttlSeconds * 1000;
    this.scopes.set(scope, entry);

    const added = new Set<string>();
    for (const key of keys) {
      if (entry.keys.has(key)) continue;
      if (entry.keys.size >= this.maxKeysPerScope) {
        const first = entry.keys.values().next().value;
        if (first !== undefined) entry.keys.delete(first);
      }
      entry.keys.add(key);
      added.add(key);
    }
    return added;
  }
}

export interface RedisLike {
  status?: string;
  pipeline(): {
    sadd(key: string, member: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
}

/** Redis-backed store; SADD is atomic per member, so concurrent attempts report once. */
export class RedisSeenStore implements SeenStore {
  constructor(
    private readonly getClient: () => RedisLike | null,
    private readonly fallback: SeenStore = new MemorySeenStore()
  ) {}

  async addNew(scope: string, keys: string[], ttlSeconds: number): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const client = this.getClient();
    if (!client || (client.status && client.status !== "ready")) {
      return this.fallback.addNew(scope, keys, ttlSeconds);
    }
    try {
      const redisKey = scopeKey(scope);
      const pipeline = client.pipeline();
      for (const key of keys) pipeline.sadd(redisKey, key);
      pipeline.expire(redisKey, ttlSeconds);
      const results = await pipeline.exec();
      if (!results) return this.fallback.addNew(scope, keys, ttlSeconds);
      const added = new Set<string>();
      keys.forEach((key, index) => {
        const [error, reply] = results[index] ?? [null, 0];
        if (!error && Number(reply) === 1) added.add(key);
      });
      return added;
    } catch {
      return this.fallback.addNew(scope, keys, ttlSeconds);
    }
  }
}

/**
 * Splits the redactions of one request into the ones that are new for this scope.
 * Duplicate keys inside the same request are reported once.
 */
export async function selectNewRedactions(
  store: SeenStore,
  scope: string,
  redactions: BodyRedaction[],
  ttlSeconds: number
): Promise<BodyRedaction[]> {
  if (redactions.length === 0) return [];
  const byKey = new Map<string, BodyRedaction>();
  for (const redaction of redactions) {
    const key = findingKey(redaction);
    if (!byKey.has(key)) byKey.set(key, redaction);
  }
  const added = await store.addNew(scope, [...byKey.keys()], ttlSeconds);
  const fresh: BodyRedaction[] = [];
  for (const [key, redaction] of byKey) {
    if (added.has(key)) fresh.push(redaction);
  }
  return fresh;
}
