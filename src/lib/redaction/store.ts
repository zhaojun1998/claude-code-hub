import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/drizzle/db";
import { keys, messageRequest, users } from "@/drizzle/schema";
import { DEFAULT_REDACTION_SETTINGS, normalizeRedactionSettings } from "./config";
import {
  REDACTION_SCHEMA_DDL,
  redactionCandidatesTable,
  redactionEventsTable,
  redactionJevCallsTable,
  redactionRulesTable,
  redactionSettingsTable,
} from "./schema";
import type {
  DiscoveredRuleStatus,
  JevCallRecord,
  JevCallsQuery,
  JevCandidateResult,
  RecordPage,
  RecordsPageQuery,
  RecordsRange,
  RedactionCategory,
  RedactionEventListItem,
  RedactionEventRecord,
  RedactionEventSummary,
  RedactionEventsQuery,
  RedactionFinding,
  RedactionRecordStats,
  RedactionRuleKind,
  RedactionSettings,
  StoredRedactionRule,
} from "./types";

const SCHEMA_LOCK_KEY = 730_191_855_201;

let schemaReady: Promise<void> | null = null;

/** Creates the fork tables once per process; concurrent workers serialize on an advisory lock. */
export function ensureRedactionSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
        for (const statement of REDACTION_SCHEMA_DDL) {
          await tx.execute(sql.raw(statement));
        }
      })
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

type RuleRow = typeof redactionRulesTable.$inferSelect;

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toStoredRule(row: RuleRow): StoredRedactionRule {
  return {
    id: row.id,
    name: row.name,
    category: row.category as RedactionCategory,
    label: row.label,
    kind: row.kind as RedactionRuleKind,
    pattern: row.pattern,
    flags: row.flags,
    groupIndex: row.groupIndex,
    source: row.source === "jev" ? "jev" : "custom",
    status: row.status as DiscoveredRuleStatus,
    confidence: row.confidence,
    description: row.description,
    hitCount: row.hitCount,
    lastHitAt: toIso(row.lastHitAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

export interface SettingsRow {
  settings: RedactionSettings;
  salt: string;
}

export async function loadSettingsRow(): Promise<SettingsRow> {
  await ensureRedactionSchema();
  const [row] = await db
    .select()
    .from(redactionSettingsTable)
    .where(eq(redactionSettingsTable.id, 1))
    .limit(1);
  if (row) {
    return { settings: normalizeRedactionSettings(row.config), salt: row.salt };
  }
  const salt = randomBytes(32).toString("hex");
  await db
    .insert(redactionSettingsTable)
    .values({ id: 1, config: DEFAULT_REDACTION_SETTINGS, salt })
    .onConflictDoNothing();
  const [created] = await db
    .select()
    .from(redactionSettingsTable)
    .where(eq(redactionSettingsTable.id, 1))
    .limit(1);
  return {
    settings: normalizeRedactionSettings(created?.config ?? DEFAULT_REDACTION_SETTINGS),
    salt: created?.salt ?? salt,
  };
}

export async function saveSettings(settings: RedactionSettings): Promise<void> {
  await loadSettingsRow();
  await db
    .update(redactionSettingsTable)
    .set({ config: settings, updatedAt: new Date() })
    .where(eq(redactionSettingsTable.id, 1));
}

export async function listStoredRules(): Promise<StoredRedactionRule[]> {
  await ensureRedactionSchema();
  const rows = await db
    .select()
    .from(redactionRulesTable)
    .orderBy(desc(redactionRulesTable.createdAt));
  return rows.map(toStoredRule);
}

export async function listActiveStoredRules(): Promise<StoredRedactionRule[]> {
  await ensureRedactionSchema();
  const rows = await db
    .select()
    .from(redactionRulesTable)
    .where(eq(redactionRulesTable.status, "active"))
    .orderBy(redactionRulesTable.id);
  return rows.map(toStoredRule);
}

export interface RuleInput {
  name: string;
  category: RedactionCategory;
  label: string;
  kind: RedactionRuleKind;
  pattern: string;
  flags?: string | null;
  groupIndex?: number | null;
  source: "custom" | "jev";
  status: DiscoveredRuleStatus;
  confidence?: number | null;
  description?: string | null;
  valueHash?: string | null;
}

export async function createStoredRule(input: RuleInput): Promise<StoredRedactionRule | null> {
  await ensureRedactionSchema();
  const [row] = await db
    .insert(redactionRulesTable)
    .values({
      name: input.name,
      category: input.category,
      label: input.label,
      kind: input.kind,
      pattern: input.pattern,
      flags: input.flags ?? null,
      groupIndex: input.groupIndex ?? null,
      source: input.source,
      status: input.status,
      confidence: input.confidence ?? null,
      description: input.description ?? null,
      valueHash: input.valueHash ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row ? toStoredRule(row) : null;
}

export async function updateStoredRule(
  id: number,
  patch: Partial<Omit<RuleInput, "source" | "valueHash">>
): Promise<StoredRedactionRule | null> {
  await ensureRedactionSchema();
  const [row] = await db
    .update(redactionRulesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(redactionRulesTable.id, id))
    .returning();
  return row ? toStoredRule(row) : null;
}

export async function deleteStoredRule(id: number): Promise<boolean> {
  await ensureRedactionSchema();
  const rows = await db
    .delete(redactionRulesTable)
    .where(eq(redactionRulesTable.id, id))
    .returning({ id: redactionRulesTable.id });
  return rows.length > 0;
}

export async function recordRuleHits(ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await ensureRedactionSchema();
  await db
    .update(redactionRulesTable)
    .set({
      hitCount: sql`${redactionRulesTable.hitCount} + 1`,
      lastHitAt: new Date(),
    })
    .where(inArray(redactionRulesTable.id, ruleIds));
}

export interface CandidateVerdictRow {
  valueHash: string;
  verdict: "sensitive" | "benign";
  category: string | null;
  confidence: number | null;
  hint: string | null;
  preview: string | null;
  ruleId: number | null;
  model: string | null;
}

export async function findCandidateVerdicts(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  await ensureRedactionSchema();
  const rows = await db
    .select({ valueHash: redactionCandidatesTable.valueHash })
    .from(redactionCandidatesTable)
    .where(inArray(redactionCandidatesTable.valueHash, hashes));
  return new Set(rows.map((row) => row.valueHash));
}

export async function saveCandidateVerdicts(rows: CandidateVerdictRow[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureRedactionSchema();
  await db.insert(redactionCandidatesTable).values(rows).onConflictDoNothing();
}

export async function clearCandidateVerdicts(): Promise<number> {
  await ensureRedactionSchema();
  const rows = await db
    .delete(redactionCandidatesTable)
    .returning({ valueHash: redactionCandidatesTable.valueHash });
  return rows.length;
}

export async function countCandidateVerdicts(): Promise<{ sensitive: number; benign: number }> {
  await ensureRedactionSchema();
  const rows = await db
    .select({
      verdict: redactionCandidatesTable.verdict,
      count: sql<number>`count(*)::int`,
    })
    .from(redactionCandidatesTable)
    .groupBy(redactionCandidatesTable.verdict);
  const result = { sensitive: 0, benign: 0 };
  for (const row of rows) {
    if (row.verdict === "sensitive") result.sensitive = Number(row.count);
    if (row.verdict === "benign") result.benign = Number(row.count);
  }
  return result;
}

export interface EventInput {
  messageRequestId: number | null;
  sessionId: string | null;
  requestSequence: number | null;
  userId: number | null;
  keyId: number | null;
  totalCount: number;
  newCount: number;
  originalsRecorded: boolean;
  findings: RedactionFinding[];
}

export async function insertRedactionEvent(input: EventInput): Promise<void> {
  await ensureRedactionSchema();
  await db.insert(redactionEventsTable).values(input);
}

/** `userId` restricts the result to one user's requests (non-admin viewers). */
export async function getEventSummaries(
  messageRequestIds: number[],
  userId?: number
): Promise<RedactionEventSummary[]> {
  if (messageRequestIds.length === 0) return [];
  await ensureRedactionSchema();
  const rows = await db
    .select({
      messageRequestId: redactionEventsTable.messageRequestId,
      totalCount: sql<number>`max(${redactionEventsTable.totalCount})::int`,
      newCount: sql<number>`sum(${redactionEventsTable.newCount})::int`,
    })
    .from(redactionEventsTable)
    .where(
      and(
        inArray(redactionEventsTable.messageRequestId, messageRequestIds),
        userId === undefined ? undefined : eq(redactionEventsTable.userId, userId)
      )
    )
    .groupBy(redactionEventsTable.messageRequestId);
  return rows
    .filter(
      (row): row is typeof row & { messageRequestId: number } => row.messageRequestId !== null
    )
    .map((row) => ({
      messageRequestId: row.messageRequestId,
      totalCount: Number(row.totalCount),
      newCount: Number(row.newCount),
    }));
}

export async function getEventsForRequest(
  messageRequestId: number,
  userId?: number
): Promise<RedactionEventRecord[]> {
  await ensureRedactionSchema();
  const rows = await db
    .select()
    .from(redactionEventsTable)
    .where(
      and(
        eq(redactionEventsTable.messageRequestId, messageRequestId),
        userId === undefined ? undefined : eq(redactionEventsTable.userId, userId)
      )
    )
    .orderBy(redactionEventsTable.id);
  return rows.map((row) => ({
    id: row.id,
    messageRequestId: row.messageRequestId,
    sessionId: row.sessionId,
    requestSequence: row.requestSequence,
    totalCount: row.totalCount,
    newCount: row.newCount,
    originalsRecorded: row.originalsRecorded,
    findings: row.findings,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
  }));
}

/** Prunes redaction records and Jev call records; returns the number of redaction records. */
export async function deleteEventsOlderThan(days: number): Promise<number> {
  await ensureRedactionSchema();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(redactionEventsTable)
    .where(lt(redactionEventsTable.createdAt, cutoff))
    .returning({ id: redactionEventsTable.id });
  await db.delete(redactionJevCallsTable).where(lt(redactionJevCallsTable.createdAt, cutoff));
  return rows.length;
}

export type JevCallInput = Omit<
  typeof redactionJevCallsTable.$inferInsert,
  "id" | "createdAt" | "results"
> & { results: JevCandidateResult[] };

export async function insertJevCall(input: JevCallInput): Promise<void> {
  await ensureRedactionSchema();
  await db.insert(redactionJevCallsTable).values(input);
}

function timeRange(column: AnyPgColumn, range: RecordsRange) {
  return [
    range.from ? gte(column, range.from) : undefined,
    range.to ? lt(column, range.to) : undefined,
  ];
}

function toPage<T>(rows: T[], query: RecordsPageQuery): RecordPage<T> {
  return {
    items: rows.slice(0, query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    hasMore: rows.length > query.pageSize,
  };
}

const requestModel = sql<
  string | null
>`coalesce(${messageRequest.originalModel}, ${messageRequest.model})`;

export async function listRedactionEvents(
  query: RedactionEventsQuery
): Promise<RecordPage<RedactionEventListItem>> {
  await ensureRedactionSchema();
  const events = redactionEventsTable;
  const rows = await db
    .select({
      id: events.id,
      messageRequestId: events.messageRequestId,
      sessionId: events.sessionId,
      requestSequence: events.requestSequence,
      userId: events.userId,
      userName: users.name,
      keyId: events.keyId,
      keyName: keys.name,
      model: requestModel,
      totalCount: events.totalCount,
      newCount: events.newCount,
      originalsRecorded: events.originalsRecorded,
      findings: events.findings,
      createdAt: events.createdAt,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.userId))
    .leftJoin(keys, eq(keys.id, events.keyId))
    .leftJoin(messageRequest, eq(messageRequest.id, events.messageRequestId))
    .where(
      and(
        ...timeRange(events.createdAt, query),
        query.sessionId ? eq(events.sessionId, query.sessionId) : undefined
      )
    )
    .orderBy(desc(events.id))
    .limit(query.pageSize + 1)
    .offset((query.page - 1) * query.pageSize);
  return toPage(
    rows.map((row) => ({
      ...row,
      model: row.model ?? null,
      createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    })),
    query
  );
}

export async function listJevCalls(query: JevCallsQuery): Promise<RecordPage<JevCallRecord>> {
  await ensureRedactionSchema();
  const calls = redactionJevCallsTable;
  const rows = await db
    .select({
      id: calls.id,
      messageRequestId: calls.messageRequestId,
      sessionId: calls.sessionId,
      requestSequence: calls.requestSequence,
      userId: calls.userId,
      userName: users.name,
      keyId: calls.keyId,
      keyName: keys.name,
      mode: calls.mode,
      sendMode: calls.sendMode,
      model: calls.model,
      candidateCount: calls.candidateCount,
      judgedCount: calls.judgedCount,
      activeRules: calls.activeRules,
      pendingRules: calls.pendingRules,
      inputTokens: calls.inputTokens,
      durationMs: calls.durationMs,
      timedOut: calls.timedOut,
      ok: calls.ok,
      error: calls.error,
      originalsRecorded: calls.originalsRecorded,
      results: calls.results,
      createdAt: calls.createdAt,
    })
    .from(calls)
    .leftJoin(users, eq(users.id, calls.userId))
    .leftJoin(keys, eq(keys.id, calls.keyId))
    .where(
      and(
        ...timeRange(calls.createdAt, query),
        query.filter === "discovered"
          ? gt(sql`${calls.activeRules} + ${calls.pendingRules}`, 0)
          : undefined,
        query.filter === "failed" ? eq(calls.ok, false) : undefined
      )
    )
    .orderBy(desc(calls.id))
    .limit(query.pageSize + 1)
    .offset((query.page - 1) * query.pageSize);
  return toPage(
    rows.map((row) => ({
      ...row,
      createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    })),
    query
  );
}

const TOP_RULES_LIMIT = 10;

export async function getRedactionStats(range: RecordsRange): Promise<RedactionRecordStats> {
  await ensureRedactionSchema();
  const events = redactionEventsTable;
  const calls = redactionJevCallsTable;
  const from = range.from?.toISOString() ?? null;
  const to = range.to?.toISOString() ?? null;
  const [[eventRow], [callRow], [pendingRow], topRows] = await Promise.all([
    db
      .select({
        events: sql<number>`count(*)::int`,
        findings: sql<number>`coalesce(sum(${events.newCount}), 0)::int`,
        sessions: sql<number>`count(distinct ${events.sessionId})::int`,
      })
      .from(events)
      .where(and(...timeRange(events.createdAt, range))),
    db
      .select({
        calls: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where not ${calls.ok})::int`,
        timedOut: sql<number>`count(*) filter (where ${calls.timedOut})::int`,
        candidates: sql<number>`coalesce(sum(${calls.candidateCount}), 0)::int`,
        activeRules: sql<number>`coalesce(sum(${calls.activeRules}), 0)::int`,
        pendingRules: sql<number>`coalesce(sum(${calls.pendingRules}), 0)::int`,
      })
      .from(calls)
      .where(and(...timeRange(calls.createdAt, range))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(redactionRulesTable)
      .where(eq(redactionRulesTable.status, "pending")),
    db.execute(sql`
      SELECT f->>'ruleId' AS rule_id, max(f->>'ruleName') AS rule_name, count(*)::int AS count
      FROM fork_redaction_events e, jsonb_array_elements(e.findings) f
      WHERE (${from}::timestamptz IS NULL OR e.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR e.created_at < ${to}::timestamptz)
      GROUP BY 1
      ORDER BY 3 DESC, 1
      LIMIT ${TOP_RULES_LIMIT}
    `),
  ]);
  return {
    events: Number(eventRow?.events ?? 0),
    findings: Number(eventRow?.findings ?? 0),
    sessions: Number(eventRow?.sessions ?? 0),
    jevCalls: Number(callRow?.calls ?? 0),
    jevFailed: Number(callRow?.failed ?? 0),
    jevTimedOut: Number(callRow?.timedOut ?? 0),
    jevCandidates: Number(callRow?.candidates ?? 0),
    jevActiveRules: Number(callRow?.activeRules ?? 0),
    jevPendingRules: Number(callRow?.pendingRules ?? 0),
    pendingReview: Number(pendingRow?.count ?? 0),
    topRules: Array.from(topRows as Iterable<Record<string, unknown>>).map((row) => ({
      ruleId: String(row.rule_id ?? ""),
      ruleName: String(row.rule_name ?? row.rule_id ?? ""),
      count: Number(row.count ?? 0),
    })),
  };
}
