import { collectTextSlots, type TextSlot } from "./body-walker";
import type { RedactionEngine } from "./engine";
import { fingerprintText } from "./incremental";
import type { BodyRedaction, TextMatch } from "./types";

const CONTEXT_CHARS = 48;

/** Small LRU of scan results keyed by rule-set version and text fingerprint. */
export class SegmentMatchCache {
  private readonly entries = new Map<string, TextMatch[]>();

  constructor(private readonly capacity = 20_000) {}

  get(key: string): TextMatch[] | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, matches: TextMatch[]): void {
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, matches);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A string scanned for the first time by this process (input for rule discovery). */
export interface FreshSegment {
  path: string;
  fingerprint: string;
  text: string;
  matches: TextMatch[];
}

interface ScannedSlot {
  slot: TextSlot;
  fingerprint: string;
  matches: TextMatch[];
}

export interface BodyScan {
  engine: RedactionEngine;
  slots: ScannedSlot[];
  freshSegments: FreshSegment[];
}

export interface RedactBodyResult {
  changed: boolean;
  redactions: BodyRedaction[];
  freshSegments: FreshSegment[];
  segmentCount: number;
}

/** Finds matches in every content string of `body` without modifying it. */
export function scanBody(
  body: unknown,
  engine: RedactionEngine,
  cache?: SegmentMatchCache
): BodyScan {
  const slots: ScannedSlot[] = [];
  const freshSegments: FreshSegment[] = [];
  for (const slot of collectTextSlots(body)) {
    const fingerprint = fingerprintText(slot.text);
    const cacheKey = `${engine.version}:${fingerprint}`;
    let matches = cache?.get(cacheKey);
    if (!matches) {
      matches = engine.findMatches(slot.text);
      cache?.set(cacheKey, matches);
      freshSegments.push({ path: slot.path, fingerprint, text: slot.text, matches });
    }
    slots.push({ slot, fingerprint, matches });
  }
  return { engine, slots, freshSegments };
}

/** Writes the replacements of a scan into the body it was taken from. */
export function applyBodyScan(scan: BodyScan): { changed: boolean; redactions: BodyRedaction[] } {
  const redactions: BodyRedaction[] = [];
  let changed = false;
  for (const { slot, fingerprint, matches } of scan.slots) {
    if (matches.length === 0) continue;
    const result = scan.engine.redactText(slot.text, matches);
    if (result.text === slot.text) continue;
    slot.set(result.text);
    changed = true;

    let delta = 0;
    for (const item of result.redactions) {
      const outStart = item.start + delta;
      const outEnd = outStart + item.replacement.length;
      delta += item.replacement.length - (item.end - item.start);
      redactions.push({
        ...item,
        path: slot.path,
        segmentFingerprint: fingerprint,
        contextBefore: result.text.slice(Math.max(0, outStart - CONTEXT_CHARS), outStart),
        contextAfter: result.text.slice(outEnd, outEnd + CONTEXT_CHARS),
      });
    }
  }
  return { changed, redactions };
}

/**
 * Redacts every content string of `body` in place. Callers must pass a body they own
 * (the forwarder passes its per-attempt deep copy).
 */
export function redactBodyInPlace(
  body: unknown,
  engine: RedactionEngine,
  cache?: SegmentMatchCache
): RedactBodyResult {
  const scan = scanBody(body, engine, cache);
  const applied = applyBodyScan(scan);
  return { ...applied, freshSegments: scan.freshSegments, segmentCount: scan.slots.length };
}
