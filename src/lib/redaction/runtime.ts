/**
 * Redaction runtime: holds the compiled rule set, redacts outbound request bodies, records
 * incremental findings for the usage log and drives Jev rule discovery.
 *
 * Dependencies are injected so the whole flow can be unit tested without a database.
 */

import { BUILTIN_RULES, isBuiltinRuleEnabled } from "./builtin-rules";
import { maskValue } from "./candidates";
import {
  type DiscoveryCandidateResult,
  type DiscoveryDeps,
  type DiscoveryOutcome,
  RuleDiscovery,
} from "./discovery";
import { RedactionEngine } from "./engine";
import { findingKey, type SeenStore, selectNewRedactions } from "./incremental";
import { applyBodyScan, type BodyScan, SegmentMatchCache, scanBody } from "./redact-body";
import type { EventInput, JevCallInput } from "./store";
import type {
  BodyRedaction,
  JevCandidateResult,
  RedactionFinding,
  RedactionRuleDefinition,
  RedactionSettings,
  StoredRedactionRule,
} from "./types";

export interface RedactionSessionLike {
  sessionId?: string | null;
  requestSequence?: number | null;
  messageContext?: {
    id: number;
    user?: { id: number } | null;
    key?: { id: number } | null;
  } | null;
  authState?: {
    user?: { id: number } | null;
    key?: { id: number } | null;
  } | null;
}

export interface RuntimeSnapshot {
  settings: RedactionSettings;
  salt: string;
  storedRules: StoredRedactionRule[];
  engine: RedactionEngine;
  loadedAt: number;
}

interface RuntimeLogger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export interface RuntimeDeps {
  loadSettingsRow(): Promise<{ settings: RedactionSettings; salt: string }>;
  listActiveStoredRules(): Promise<StoredRedactionRule[]>;
  seenStore: SeenStore;
  insertEvent(input: EventInput): Promise<void>;
  insertJevCall?(input: JevCallInput): Promise<void>;
  recordRuleHits(ruleIds: number[]): Promise<void>;
  deleteEventsOlderThan(days: number): Promise<number>;
  discovery: Omit<DiscoveryDeps, "onRulesChanged" | "onError">;
  /** Tells other workers to reload (Redis pub/sub). */
  publishInvalidation?(): Promise<void>;
  logger: RuntimeLogger;
  now?: () => number;
}

export interface OutboundResult {
  changed: boolean;
  redactionCount: number;
  discovery?: DiscoveryOutcome | null;
}

const SNAPSHOT_TTL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_STORED_FINDINGS = 200;
const RECORDED_REQUEST_CAPACITY = 10_000;

export function storedRuleToDefinition(rule: StoredRedactionRule): RedactionRuleDefinition {
  return {
    id: `${rule.source}:${rule.id}`,
    name: rule.name,
    category: rule.category,
    label: rule.label,
    kind: rule.kind,
    pattern: rule.pattern,
    flags: rule.flags ?? undefined,
    group: rule.groupIndex ?? undefined,
    source: rule.source,
  };
}

/** Enabled built-ins first (specific before generic), then custom rules, then Jev rules. */
export function buildRuleList(
  settings: RedactionSettings,
  storedRules: StoredRedactionRule[]
): RedactionRuleDefinition[] {
  const builtins = BUILTIN_RULES.filter((rule) =>
    isBuiltinRuleEnabled(rule, settings.builtinOverrides)
  );
  const active = storedRules.filter((rule) => rule.status === "active");
  const custom = active.filter((rule) => rule.source === "custom").map(storedRuleToDefinition);
  const jev = active.filter((rule) => rule.source === "jev").map(storedRuleToDefinition);
  return [...builtins, ...custom, ...jev];
}

export function buildEngine(
  settings: RedactionSettings,
  salt: string,
  storedRules: StoredRedactionRule[]
): RedactionEngine {
  return new RedactionEngine(buildRuleList(settings, storedRules), {
    placeholderTemplate: settings.placeholderTemplate,
    salt,
    allowlist: settings.allowlist,
  });
}

function sessionScope(session: RedactionSessionLike): string | null {
  if (session.sessionId) return `session:${session.sessionId}`;
  const keyId = session.messageContext?.key?.id ?? session.authState?.key?.id;
  return typeof keyId === "number" ? `key:${keyId}` : null;
}

function requestIdentity(session: RedactionSessionLike) {
  return {
    messageRequestId: session.messageContext?.id ?? null,
    sessionId: session.sessionId ?? null,
    requestSequence: session.requestSequence ?? null,
    userId: session.messageContext?.user?.id ?? session.authState?.user?.id ?? null,
    keyId: session.messageContext?.key?.id ?? session.authState?.key?.id ?? null,
  };
}

function storedRuleId(ruleId: string): number | null {
  const match = /^(?:custom|jev):(\d+)$/.exec(ruleId);
  return match ? Number(match[1]) : null;
}

export function toFinding(redaction: BodyRedaction, recordOriginals: boolean): RedactionFinding {
  return {
    ruleId: redaction.ruleId,
    ruleName: redaction.ruleName,
    category: redaction.category,
    original: recordOriginals ? redaction.original : maskValue(redaction.original),
    replacement: redaction.replacement,
    path: redaction.path,
    contextBefore: redaction.contextBefore,
    contextAfter: redaction.contextAfter,
  };
}

export function toJevResult(
  result: DiscoveryCandidateResult,
  recordOriginals: boolean
): JevCandidateResult {
  const { candidate } = result;
  return {
    value: recordOriginals ? candidate.value : maskValue(candidate.value),
    hint: candidate.hint,
    keyName: candidate.keyName ?? null,
    path: candidate.path,
    category: result.category,
    confidence: result.confidence,
    outcome: result.outcome,
    ruleIds: result.ruleIds,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RedactionRuntime {
  private snapshot: RuntimeSnapshot | null = null;
  private loading: Promise<RuntimeSnapshot | null> | null = null;
  private stale = true;
  private lastCleanupAt = 0;
  private readonly cache = new SegmentMatchCache();
  private readonly recordedSessions = new WeakSet<object>();
  private readonly recordedRequests = new Set<number>();
  private readonly discovery: RuleDiscovery;
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.discovery = new RuleDiscovery(
      {
        ...deps.discovery,
        onRulesChanged: async () => {
          this.invalidate();
          await this.reload();
          await deps.publishInvalidation?.().catch(() => undefined);
        },
        onError: (message, detail) => deps.logger.warn(message, detail),
      },
      this.now
    );
  }

  /** Marks the snapshot stale; the next request reloads settings and rules. */
  invalidate(): void {
    this.stale = true;
  }

  get currentSnapshot(): RuntimeSnapshot | null {
    return this.snapshot;
  }

  async reload(): Promise<RuntimeSnapshot | null> {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const [{ settings, salt }, storedRules] = await Promise.all([
            this.deps.loadSettingsRow(),
            this.deps.listActiveStoredRules(),
          ]);
          const engine = buildEngine(settings, salt, storedRules);
          for (const issue of engine.issues) {
            this.deps.logger.warn("[Redaction] Rule skipped", { ...issue });
          }
          this.snapshot = { settings, salt, storedRules, engine, loadedAt: this.now() };
          this.stale = false;
          return this.snapshot;
        } catch (error) {
          this.deps.logger.error("[Redaction] Failed to load settings", {
            error: error instanceof Error ? error.message : String(error),
          });
          return this.snapshot;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  async getSnapshot(): Promise<RuntimeSnapshot | null> {
    if (!this.snapshot || this.stale) return this.reload();
    if (this.now() - this.snapshot.loadedAt > SNAPSHOT_TTL_MS) {
      // Refresh in the background; serve the current rules meanwhile.
      void this.reload();
    }
    return this.snapshot;
  }

  /** True only for the first attempt of a request (retries and hedges share the record). */
  private claimRecording(session: RedactionSessionLike): boolean {
    if (this.recordedSessions.has(session)) return false;
    this.recordedSessions.add(session);
    const requestId = session.messageContext?.id;
    if (typeof requestId === "number") {
      if (this.recordedRequests.has(requestId)) return false;
      if (this.recordedRequests.size >= RECORDED_REQUEST_CAPACITY) {
        const oldest = this.recordedRequests.values().next().value;
        if (oldest !== undefined) this.recordedRequests.delete(oldest);
      }
      this.recordedRequests.add(requestId);
    }
    return true;
  }

  /**
   * Redacts `body` in place. The body must be a copy owned by the caller. Returns whether
   * anything changed; never throws.
   */
  async redactOutbound(session: RedactionSessionLike, body: unknown): Promise<OutboundResult> {
    const snapshot = await this.getSnapshot();
    if (!snapshot?.settings.enabled) return { changed: false, redactionCount: 0 };

    let scan: BodyScan = scanBody(body, snapshot.engine, this.cache);
    const firstAttempt = this.claimRecording(session);
    let discovery: DiscoveryOutcome | null | undefined;

    const jev = snapshot.settings.jev;
    if (firstAttempt && jev.enabled && jev.apiKey && scan.freshSegments.length > 0) {
      const startedAt = this.now();
      const pending = this.discovery.discover(scan.freshSegments, jev).catch((error) => {
        this.deps.logger.warn("[Redaction] Rule discovery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      // Recorded when discovery settles, also when a sync wait gave up on it.
      void pending
        .then((outcome) =>
          outcome
            ? this.recordJevCall(session, outcome, snapshot.settings, this.now() - startedAt)
            : undefined
        )
        .catch((error) => {
          this.deps.logger.warn("[Redaction] Failed to record Jev call", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      if (jev.mode === "sync") {
        discovery = await withTimeout(pending, jev.timeoutMs);
        if (discovery && discovery.activeRules > 0) {
          const refreshed = await this.getSnapshot();
          if (refreshed?.settings.enabled) {
            scan = scanBody(body, refreshed.engine, this.cache);
          }
        }
      }
    }

    const applied = applyBodyScan(scan);
    if (firstAttempt && applied.redactions.length > 0) {
      void this.record(session, applied.redactions, snapshot.settings).catch((error) => {
        this.deps.logger.warn("[Redaction] Failed to record redaction event", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { changed: applied.changed, redactionCount: applied.redactions.length, discovery };
  }

  /** Raw passthrough bodies (count_tokens, responses/compact). Returns null when unchanged. */
  async redactRawBody(
    session: RedactionSessionLike,
    raw: ArrayBuffer | string
  ): Promise<string | null> {
    const snapshot = await this.getSnapshot();
    if (!snapshot?.settings.enabled) return null;
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    const result = await this.redactOutbound(session, body);
    return result.changed ? JSON.stringify(body) : null;
  }

  private async record(
    session: RedactionSessionLike,
    redactions: BodyRedaction[],
    settings: RedactionSettings
  ): Promise<void> {
    const unique = new Map<string, BodyRedaction>();
    for (const redaction of redactions) {
      const key = findingKey(redaction);
      if (!unique.has(key)) unique.set(key, redaction);
    }
    const all = [...unique.values()];
    const scope = sessionScope(session);
    const fresh = scope
      ? await selectNewRedactions(
          this.deps.seenStore,
          scope,
          all,
          settings.incrementalTtlHours * 3600
        )
      : all;

    const hitIds = [
      ...new Set(
        fresh.map((r) => storedRuleId(r.ruleId)).filter((id): id is number => id !== null)
      ),
    ];
    if (hitIds.length > 0) {
      void this.deps.recordRuleHits(hitIds).catch(() => undefined);
    }
    if (fresh.length === 0) return;

    await this.deps.insertEvent({
      ...requestIdentity(session),
      totalCount: all.length,
      newCount: fresh.length,
      originalsRecorded: settings.recordOriginals,
      findings: fresh
        .slice(0, MAX_STORED_FINDINGS)
        .map((redaction) => toFinding(redaction, settings.recordOriginals)),
    });

    this.maybeCleanup(settings);
  }

  /** Only requests that actually sent candidates to Jev are recorded. */
  private async recordJevCall(
    session: RedactionSessionLike,
    outcome: DiscoveryOutcome,
    settings: RedactionSettings,
    durationMs: number
  ): Promise<void> {
    if (!this.deps.insertJevCall || outcome.candidates === 0) return;
    const { jev } = settings;
    await this.deps.insertJevCall({
      ...requestIdentity(session),
      mode: jev.mode,
      sendMode: jev.sendMode,
      model: outcome.model ?? jev.model,
      candidateCount: outcome.candidates,
      judgedCount: outcome.judged,
      activeRules: outcome.activeRules,
      pendingRules: outcome.pendingRules,
      inputTokens: outcome.inputTokens > 0 ? outcome.inputTokens : null,
      durationMs: Math.max(0, Math.round(durationMs)),
      timedOut: jev.mode === "sync" && durationMs > jev.timeoutMs,
      ok: outcome.errors.length === 0,
      error: outcome.errors.length > 0 ? outcome.errors.join("; ").slice(0, 500) : null,
      originalsRecorded: settings.recordOriginals,
      results: outcome.results
        .slice(0, MAX_STORED_FINDINGS)
        .map((result) => toJevResult(result, settings.recordOriginals)),
    });
    this.maybeCleanup(settings);
  }

  private maybeCleanup(settings: RedactionSettings): void {
    if (this.now() - this.lastCleanupAt <= CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = this.now();
    void this.deps.deleteEventsOlderThan(settings.eventRetentionDays).catch(() => undefined);
  }
}
