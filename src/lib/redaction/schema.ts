/**
 * Tables owned by the redaction fork feature.
 *
 * They are deliberately kept out of `src/drizzle/schema.ts` and the drizzle-kit migration
 * journal: the fork follows upstream, and upstream migrations are numbered sequentially, so
 * any fork migration would conflict on every sync. The tables are created idempotently at
 * runtime by `ensureRedactionSchema()` instead (see `store.ts`).
 */

import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { JevCandidateResult, RedactionFinding } from "./types";

export const redactionSettingsTable = pgTable("fork_redaction_settings", {
  id: integer("id").primaryKey(),
  config: jsonb("config").notNull(),
  salt: text("salt").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const redactionRulesTable = pgTable(
  "fork_redaction_rules",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 128 }).notNull(),
    category: varchar("category", { length: 16 }).notNull(),
    label: varchar("label", { length: 48 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    pattern: text("pattern").notNull(),
    flags: varchar("flags", { length: 8 }),
    groupIndex: integer("group_index"),
    source: varchar("source", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    confidence: real("confidence"),
    description: text("description"),
    valueHash: varchar("value_hash", { length: 64 }),
    hitCount: integer("hit_count").default(0).notNull(),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("fork_redaction_rules_value_hash_uq").on(table.valueHash)]
);

export const redactionCandidatesTable = pgTable("fork_redaction_candidates", {
  valueHash: varchar("value_hash", { length: 64 }).primaryKey(),
  verdict: varchar("verdict", { length: 16 }).notNull(),
  category: varchar("category", { length: 16 }),
  confidence: real("confidence"),
  hint: varchar("hint", { length: 32 }),
  preview: varchar("preview", { length: 64 }),
  ruleId: integer("rule_id"),
  model: varchar("model", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const redactionEventsTable = pgTable(
  "fork_redaction_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageRequestId: integer("message_request_id"),
    sessionId: varchar("session_id", { length: 256 }),
    requestSequence: integer("request_sequence"),
    userId: integer("user_id"),
    keyId: integer("key_id"),
    totalCount: integer("total_count").notNull(),
    newCount: integer("new_count").notNull(),
    originalsRecorded: boolean("originals_recorded").default(true).notNull(),
    findings: jsonb("findings").$type<RedactionFinding[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("fork_redaction_events_request_idx").on(table.messageRequestId),
    index("fork_redaction_events_created_idx").on(table.createdAt),
  ]
);

/** One row per request that sent candidates to Jev (rule discovery). */
export const redactionJevCallsTable = pgTable(
  "fork_redaction_jev_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageRequestId: integer("message_request_id"),
    sessionId: varchar("session_id", { length: 256 }),
    requestSequence: integer("request_sequence"),
    userId: integer("user_id"),
    keyId: integer("key_id"),
    mode: varchar("mode", { length: 8 }).notNull(),
    sendMode: varchar("send_mode", { length: 8 }).notNull(),
    model: varchar("model", { length: 255 }),
    candidateCount: integer("candidate_count").notNull(),
    judgedCount: integer("judged_count").notNull(),
    activeRules: integer("active_rules").notNull(),
    pendingRules: integer("pending_rules").notNull(),
    inputTokens: integer("input_tokens"),
    durationMs: integer("duration_ms").notNull(),
    timedOut: boolean("timed_out").default(false).notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    originalsRecorded: boolean("originals_recorded").default(true).notNull(),
    results: jsonb("results").$type<JevCandidateResult[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("fork_redaction_jev_calls_created_idx").on(table.createdAt)]
);

/** Idempotent DDL matching the table definitions above. */
export const REDACTION_SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS fork_redaction_settings (
    id integer PRIMARY KEY,
    config jsonb NOT NULL,
    salt text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS fork_redaction_rules (
    id serial PRIMARY KEY,
    name varchar(128) NOT NULL,
    category varchar(16) NOT NULL,
    label varchar(48) NOT NULL,
    kind varchar(16) NOT NULL,
    pattern text NOT NULL,
    flags varchar(8),
    group_index integer,
    source varchar(16) NOT NULL,
    status varchar(16) NOT NULL,
    confidence real,
    description text,
    value_hash varchar(64),
    hit_count integer NOT NULL DEFAULT 0,
    last_hit_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fork_redaction_rules_value_hash_uq
    ON fork_redaction_rules (value_hash)`,
  `CREATE TABLE IF NOT EXISTS fork_redaction_candidates (
    value_hash varchar(64) PRIMARY KEY,
    verdict varchar(16) NOT NULL,
    category varchar(16),
    confidence real,
    hint varchar(32),
    preview varchar(64),
    rule_id integer,
    model varchar(255),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS fork_redaction_events (
    id bigserial PRIMARY KEY,
    message_request_id integer,
    session_id varchar(256),
    request_sequence integer,
    user_id integer,
    key_id integer,
    total_count integer NOT NULL,
    new_count integer NOT NULL,
    originals_recorded boolean NOT NULL DEFAULT true,
    findings jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS fork_redaction_events_request_idx
    ON fork_redaction_events (message_request_id)`,
  `CREATE INDEX IF NOT EXISTS fork_redaction_events_created_idx
    ON fork_redaction_events (created_at)`,
  `CREATE TABLE IF NOT EXISTS fork_redaction_jev_calls (
    id bigserial PRIMARY KEY,
    message_request_id integer,
    session_id varchar(256),
    request_sequence integer,
    user_id integer,
    key_id integer,
    mode varchar(8) NOT NULL,
    send_mode varchar(8) NOT NULL,
    model varchar(255),
    candidate_count integer NOT NULL,
    judged_count integer NOT NULL,
    active_rules integer NOT NULL,
    pending_rules integer NOT NULL,
    input_tokens integer,
    duration_ms integer NOT NULL,
    timed_out boolean NOT NULL DEFAULT false,
    ok boolean NOT NULL,
    error text,
    originals_recorded boolean NOT NULL DEFAULT true,
    results jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS fork_redaction_jev_calls_created_idx
    ON fork_redaction_jev_calls (created_at)`,
];
