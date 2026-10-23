import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { DEFAULT_REDACTION_SETTINGS, normalizeRedactionSettings } from "./config";
import {
  REDACTION_SCHEMA_DDL,
  redactionCandidatesTable,
  redactionEventsTable,
  redactionRulesTable,
  redactionSettingsTable,
} from "./schema";
import type {
  DiscoveredRuleStatus,
  RedactionCategory,
  RedactionEventRecord,
  RedactionEventSummary,
  RedactionFinding,
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

export async function deleteEventsOlderThan(days: number): Promise<number> {
  await ensureRedactionSchema();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(redactionEventsTable)
    .where(lt(redactionEventsTable.createdAt, cutoff))
    .returning({ id: redactionEventsTable.id });
  return rows.length;
}
