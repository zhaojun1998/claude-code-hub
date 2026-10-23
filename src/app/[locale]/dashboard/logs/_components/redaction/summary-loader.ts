"use client";

import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionEventSummary } from "@/lib/redaction/types";

/**
 * Batches redaction summary lookups of all visible usage log rows into one action call.
 * Empty results expire quickly because a request that is still streaming may be recorded
 * a moment later.
 */

type Entry = { summary: RedactionEventSummary | null; loadedAt: number };
type Fetcher = (ids: number[]) => Promise<RedactionEventSummary[]>;

const EMPTY_TTL_MS = 15_000;
const BATCH_DELAY_MS = 50;
const MAX_BATCH = 500;

async function defaultFetcher(ids: number[]): Promise<RedactionEventSummary[]> {
  const result = await redactionApi.getSummaries(ids);
  return result.ok ? result.data : [];
}

export function createSummaryLoader(
  fetcher: Fetcher = defaultFetcher,
  now: () => number = Date.now
) {
  const entries = new Map<number, Entry>();
  const waiters = new Map<number, Array<(summary: RedactionEventSummary | null) => void>>();
  let queue = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settle = (id: number, summary: RedactionEventSummary | null) => {
    entries.set(id, { summary, loadedAt: now() });
    for (const resolve of waiters.get(id) ?? []) resolve(summary);
    waiters.delete(id);
  };

  const flush = async () => {
    timer = null;
    const ids = [...queue];
    queue = new Set();
    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const batch = ids.slice(i, i + MAX_BATCH);
      let summaries: RedactionEventSummary[] = [];
      try {
        summaries = await fetcher(batch);
      } catch {
        summaries = [];
      }
      const byId = new Map(summaries.map((summary) => [summary.messageRequestId, summary]));
      for (const id of batch) settle(id, byId.get(id) ?? null);
    }
  };

  return {
    peek(id: number): RedactionEventSummary | null | undefined {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (!entry.summary && now() - entry.loadedAt > EMPTY_TTL_MS) return undefined;
      return entry.summary;
    },
    load(id: number): Promise<RedactionEventSummary | null> {
      const cached = this.peek(id);
      if (cached !== undefined) return Promise.resolve(cached);
      return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        list.push(resolve);
        waiters.set(id, list);
        queue.add(id);
        if (!timer) timer = setTimeout(() => void flush(), BATCH_DELAY_MS);
      });
    },
  };
}

export const redactionSummaryLoader = createSummaryLoader();
