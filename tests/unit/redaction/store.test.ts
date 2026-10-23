import { beforeEach, describe, expect, test, vi } from "vitest";

// Minimal stand-in for the Drizzle query builder: every chained call is recorded and the
// awaited chain resolves to the next queued result.
const fake = vi.hoisted(() => {
  const state = {
    results: [] as unknown[],
    executeResults: [] as unknown[],
    calls: [] as Array<[string, unknown[]]>,
    failTransaction: 0,
  };
  function chain(kind: string): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const value = state.results.shift();
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              Promise.resolve(value).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            state.calls.push([`${kind}.${String(prop)}`, args]);
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  const db = {
    select: (...args: unknown[]) => {
      state.calls.push(["select", args]);
      return chain("select");
    },
    insert: (...args: unknown[]) => {
      state.calls.push(["insert", args]);
      return chain("insert");
    },
    update: (...args: unknown[]) => {
      state.calls.push(["update", args]);
      return chain("update");
    },
    delete: (...args: unknown[]) => {
      state.calls.push(["delete", args]);
      return chain("delete");
    },
    execute: async (query: unknown) => {
      state.calls.push(["db.execute", [query]]);
      return state.executeResults.shift();
    },
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      if (state.failTransaction > 0) {
        state.failTransaction--;
        throw new Error("db down");
      }
      await fn({
        execute: async (query: unknown) => {
          state.calls.push(["execute", [query]]);
        },
      });
    },
  };
  return { state, db };
});

vi.mock("@/drizzle/db", () => ({ db: fake.db }));

import {
  REDACTION_SCHEMA_DDL,
  redactionEventsTable,
  redactionJevCallsTable,
} from "@/lib/redaction/schema";
import * as store from "@/lib/redaction/store";

const created = new Date("2026-01-02T03:04:05.000Z");

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Acme",
    category: "secret",
    label: "ACME",
    kind: "literal",
    pattern: "acme-secret",
    flags: null,
    groupIndex: null,
    source: "custom",
    status: "active",
    confidence: null,
    description: null,
    valueHash: null,
    hitCount: 2,
    lastHitAt: null,
    createdAt: created,
    updatedAt: "2026-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function callsOf(prefix: string) {
  return fake.state.calls.filter(([name]) => name.startsWith(prefix));
}

beforeEach(() => {
  fake.state.results = [];
  fake.state.calls = [];
});

describe("redaction store", () => {
  test("schema creation runs once and retries after a failure", async () => {
    fake.state.failTransaction = 1;
    await expect(store.ensureRedactionSchema()).rejects.toThrow("db down");
    await store.ensureRedactionSchema();
    await store.ensureRedactionSchema();
    // Advisory lock plus every DDL statement, executed exactly once.
    expect(callsOf("execute")).toHaveLength(REDACTION_SCHEMA_DDL.length + 1);
  });

  test("settings row is created with a random salt when missing", async () => {
    fake.state.results = [[], undefined, [{ config: { enabled: true }, salt: "stored-salt" }]];
    const row = await store.loadSettingsRow();
    expect(row.salt).toBe("stored-salt");
    expect(row.settings.enabled).toBe(true);
    const inserted = callsOf("insert.values")[0][1][0] as { id: number; salt: string };
    expect(inserted.id).toBe(1);
    expect(inserted.salt).toMatch(/^[0-9a-f]{64}$/);

    fake.state.results = [[], undefined, []];
    const fallback = await store.loadSettingsRow();
    expect(fallback.settings.enabled).toBe(false);
    expect(fallback.salt).toMatch(/^[0-9a-f]{64}$/);
  });

  test("existing settings are normalized and saved", async () => {
    fake.state.results = [[{ config: { enabled: true, allowlist: ["a"] }, salt: "s" }]];
    const row = await store.loadSettingsRow();
    expect(row.settings.allowlist).toEqual(["a"]);

    fake.state.results = [[{ config: {}, salt: "s" }], undefined];
    await store.saveSettings(row.settings);
    const set = callsOf("update.set")[0][1][0] as { config: unknown; updatedAt: Date };
    expect(set.config).toBe(row.settings);
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  test("rules are mapped to their public shape", async () => {
    fake.state.results = [
      [ruleRow(), ruleRow({ id: 2, source: "jev", lastHitAt: "2026-02-01T00:00:00.000Z" })],
    ];
    const rules = await store.listStoredRules();
    expect(rules[0]).toMatchObject({
      id: 1,
      source: "custom",
      createdAt: created.toISOString(),
      updatedAt: "2026-01-03T00:00:00.000Z",
      lastHitAt: null,
    });
    expect(rules[1]).toMatchObject({ source: "jev", lastHitAt: "2026-02-01T00:00:00.000Z" });

    fake.state.results = [[ruleRow({ createdAt: null, updatedAt: null })]];
    const [active] = await store.listActiveStoredRules();
    expect(active.createdAt).toBe(new Date(0).toISOString());
  });

  test("rule create, update and delete", async () => {
    fake.state.results = [[ruleRow({ id: 5 })]];
    const rule = await store.createStoredRule({
      name: "Acme",
      category: "secret",
      label: "ACME",
      kind: "literal",
      pattern: "acme-secret",
      source: "jev",
      status: "pending",
      valueHash: "h",
    });
    expect(rule?.id).toBe(5);
    const values = callsOf("insert.values")[0][1][0] as Record<string, unknown>;
    expect(values).toMatchObject({ flags: null, groupIndex: null, valueHash: "h" });

    fake.state.results = [[]];
    expect(
      await store.createStoredRule({
        name: "Dup",
        category: "secret",
        label: "ACME",
        kind: "literal",
        pattern: "acme-secret",
        source: "custom",
        status: "active",
      })
    ).toBeNull();

    fake.state.results = [[ruleRow({ status: "rejected" })]];
    expect((await store.updateStoredRule(1, { status: "rejected" }))?.status).toBe("rejected");
    fake.state.results = [[]];
    expect(await store.updateStoredRule(9, { status: "active" })).toBeNull();

    fake.state.results = [[{ id: 1 }]];
    expect(await store.deleteStoredRule(1)).toBe(true);
    fake.state.results = [[]];
    expect(await store.deleteStoredRule(2)).toBe(false);
  });

  test("rule hits skip empty input", async () => {
    await store.recordRuleHits([]);
    expect(callsOf("update")).toHaveLength(0);
    await store.recordRuleHits([1, 2]);
    expect(callsOf("update.set")).toHaveLength(1);
  });

  test("candidate verdicts", async () => {
    expect(await store.findCandidateVerdicts([])).toEqual(new Set());
    expect(callsOf("select")).toHaveLength(0);
    fake.state.results = [[{ valueHash: "a" }, { valueHash: "b" }]];
    expect(await store.findCandidateVerdicts(["a", "b", "c"])).toEqual(new Set(["a", "b"]));

    await store.saveCandidateVerdicts([]);
    expect(callsOf("insert")).toHaveLength(0);
    const row = {
      valueHash: "a",
      verdict: "benign" as const,
      category: "benign",
      confidence: 0.9,
      hint: "high_entropy",
      preview: "x",
      ruleId: null,
      model: "jev-latest",
    };
    await store.saveCandidateVerdicts([row]);
    expect(callsOf("insert.values")[0][1][0]).toEqual([row]);

    fake.state.results = [[{ valueHash: "a" }, { valueHash: "b" }]];
    expect(await store.clearCandidateVerdicts()).toBe(2);

    fake.state.results = [
      [
        { verdict: "sensitive", count: "3" },
        { verdict: "benign", count: 4 },
      ],
    ];
    expect(await store.countCandidateVerdicts()).toEqual({ sensitive: 3, benign: 4 });
  });

  test("events: insert, summaries, details and retention", async () => {
    const event = {
      messageRequestId: 1,
      sessionId: "s",
      requestSequence: 2,
      userId: 3,
      keyId: 4,
      totalCount: 2,
      newCount: 1,
      originalsRecorded: true,
      findings: [],
    };
    await store.insertRedactionEvent(event);
    expect(callsOf("insert.values")[0][1][0]).toBe(event);

    expect(await store.getEventSummaries([])).toEqual([]);
    fake.state.results = [
      [
        { messageRequestId: 1, totalCount: "2", newCount: "1" },
        { messageRequestId: null, totalCount: 1, newCount: 1 },
      ],
    ];
    expect(await store.getEventSummaries([1, 2], 3)).toEqual([
      { messageRequestId: 1, totalCount: 2, newCount: 1 },
    ]);

    fake.state.results = [[{ id: 7, ...event, createdAt: created }]];
    const [record] = await store.getEventsForRequest(1);
    expect(record).toMatchObject({ id: 7, newCount: 1, createdAt: created.toISOString() });

    fake.state.results = [[{ id: 1 }, { id: 2 }], undefined];
    expect(await store.deleteEventsOlderThan(30)).toBe(2);
    // Jev call records share the retention period.
    expect(fake.state.calls.filter(([name]) => name === "delete")).toEqual([
      ["delete", [redactionEventsTable]],
      ["delete", [redactionJevCallsTable]],
    ]);
  });

  test("Jev calls are inserted as given", async () => {
    const input = {
      messageRequestId: 1,
      sessionId: "s",
      requestSequence: 1,
      userId: 2,
      keyId: 3,
      mode: "sync",
      sendMode: "masked",
      model: "jev-latest",
      candidateCount: 1,
      judgedCount: 1,
      activeRules: 1,
      pendingRules: 0,
      inputTokens: null,
      durationMs: 12,
      timedOut: false,
      ok: true,
      error: null,
      originalsRecorded: true,
      results: [],
    };
    fake.state.results = [undefined];
    await store.insertJevCall(input);
    expect(callsOf("insert")[0][1][0]).toBe(redactionJevCallsTable);
    expect(callsOf("insert.values")[0][1][0]).toBe(input);
  });

  test("record lists are paged and mapped", async () => {
    const query = { page: 2, pageSize: 2, from: created, to: null, sessionId: "s" };
    fake.state.results = [
      [
        { id: 3, model: null, createdAt: created, findings: [] },
        { id: 2, model: "claude", createdAt: "2026-01-01T00:00:00.000Z", findings: [] },
        { id: 1, model: null, createdAt: null, findings: [] },
      ],
    ];
    const events = await store.listRedactionEvents(query);
    expect(events).toMatchObject({ page: 2, pageSize: 2, hasMore: true });
    expect(events.items.map((item) => [item.id, item.model, item.createdAt])).toEqual([
      [3, null, created.toISOString()],
      [2, "claude", "2026-01-01T00:00:00.000Z"],
    ]);
    expect(callsOf("select.limit")[0][1]).toEqual([3]);
    expect(callsOf("select.offset")[0][1]).toEqual([2]);
    expect(callsOf("select.leftJoin")).toHaveLength(3);

    fake.state.results = [[{ id: 1, createdAt: null }]];
    const calls = await store.listJevCalls({ page: 1, pageSize: 20, filter: "discovered" });
    expect(calls).toMatchObject({ hasMore: false, items: [{ id: 1 }] });
    expect(calls.items[0].createdAt).toBe(new Date(0).toISOString());
    expect(callsOf("select.offset").at(-1)?.[1]).toEqual([0]);

    fake.state.results = [[]];
    expect((await store.listJevCalls({ page: 1, pageSize: 5, filter: "failed" })).items).toEqual(
      []
    );
  });

  test("stats aggregate both tables and the most frequent rules", async () => {
    fake.state.results = [
      [{ events: "4", findings: 9, sessions: 2 }],
      [
        {
          calls: 3,
          failed: 1,
          timedOut: "1",
          candidates: 7,
          activeRules: 2,
          pendingRules: 1,
        },
      ],
      [{ count: 5 }],
    ];
    fake.state.executeResults = [
      [
        { rule_id: "builtin:email", rule_name: "Email", count: "6" },
        { rule_id: "jev:3", rule_name: null, count: 3 },
      ],
    ];
    expect(
      await store.getRedactionStats({ from: created, to: new Date("2026-02-01T00:00:00.000Z") })
    ).toEqual({
      events: 4,
      findings: 9,
      sessions: 2,
      jevCalls: 3,
      jevFailed: 1,
      jevTimedOut: 1,
      jevCandidates: 7,
      jevActiveRules: 2,
      jevPendingRules: 1,
      pendingReview: 5,
      topRules: [
        { ruleId: "builtin:email", ruleName: "Email", count: 6 },
        { ruleId: "jev:3", ruleName: "jev:3", count: 3 },
      ],
    });

    // Empty tables still produce zeros.
    fake.state.results = [[], [], []];
    fake.state.executeResults = [[]];
    const empty = await store.getRedactionStats({});
    expect(empty).toMatchObject({ events: 0, jevCalls: 0, pendingReview: 0, topRules: [] });
  });
});
