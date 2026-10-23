import { describe, expect, test, vi } from "vitest";
import { normalizeRedactionSettings } from "@/lib/redaction/config";
import { MemorySeenStore } from "@/lib/redaction/incremental";
import {
  buildRuleList,
  RedactionRuntime,
  type RedactionSessionLike,
  storedRuleToDefinition,
  toFinding,
} from "@/lib/redaction/runtime";
import type { EventInput, JevCallInput } from "@/lib/redaction/store";
import type { StoredRedactionRule } from "@/lib/redaction/types";

const KEY = "sk-proj-" + "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8nP0rS2uV";
const INTERNAL = "acme_Q8zR3kD7lM2nP9xW4yV6bT1c";

function stored(
  partial: Partial<StoredRedactionRule> & Pick<StoredRedactionRule, "id">
): StoredRedactionRule {
  return {
    name: "rule",
    category: "secret",
    label: "SECRET",
    kind: "literal",
    pattern: INTERNAL,
    flags: null,
    groupIndex: null,
    source: "custom",
    status: "active",
    confidence: null,
    description: null,
    hitCount: 0,
    lastHitAt: null,
    createdAt: "",
    updatedAt: "",
    ...partial,
  };
}

function setup(
  settingsInput: Record<string, unknown> = {},
  rules: StoredRedactionRule[] = [],
  now: () => number = Date.now
) {
  let settings = normalizeRedactionSettings({ enabled: true, ...settingsInput });
  const storedRules = [...rules];
  const events: EventInput[] = [];
  const jevCalls: JevCallInput[] = [];
  const deps = {
    now,
    insertJevCall: vi.fn(async (input: JevCallInput) => {
      jevCalls.push(input);
    }),
    loadSettingsRow: vi.fn(async () => ({ settings, salt: "salt" })),
    listActiveStoredRules: vi.fn(async () =>
      storedRules.filter((rule) => rule.status === "active")
    ),
    seenStore: new MemorySeenStore(),
    insertEvent: vi.fn(async (input: EventInput) => {
      events.push(input);
    }),
    recordRuleHits: vi.fn(async () => undefined),
    deleteEventsOlderThan: vi.fn(async () => 0),
    discovery: {
      callJev: vi.fn(async () => ({ ok: true, judgements: [], durationMs: 1 })),
      findCandidateVerdicts: vi.fn(async () => new Set<string>()),
      saveCandidateVerdicts: vi.fn(async () => undefined),
      createStoredRule: vi.fn(
        async (input: {
          pattern: string;
          status: StoredRedactionRule["status"];
          kind: StoredRedactionRule["kind"];
        }) => {
          const rule = stored({
            id: storedRules.length + 100,
            source: "jev",
            pattern: input.pattern,
            status: input.status,
            kind: input.kind,
          });
          storedRules.push(rule);
          return rule;
        }
      ),
    },
    publishInvalidation: vi.fn(async () => undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const runtime = new RedactionRuntime(deps);
  return {
    runtime,
    deps,
    events,
    jevCalls,
    setSettings(next: Record<string, unknown>) {
      settings = normalizeRedactionSettings({ enabled: true, ...next });
      runtime.invalidate();
    },
  };
}

function session(id: number, sessionId = "sess-1"): RedactionSessionLike {
  return {
    sessionId,
    requestSequence: id,
    messageContext: { id, user: { id: 7 }, key: { id: 9 } },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RedactionRuntime", () => {
  test("disabled settings leave the body untouched", async () => {
    const { runtime, events } = setup({ enabled: false });
    const body = { messages: [{ role: "user", content: KEY }] };
    expect(await runtime.redactOutbound(session(1), body)).toEqual({
      changed: false,
      redactionCount: 0,
    });
    expect(body.messages[0].content).toBe(KEY);
    expect(events).toHaveLength(0);
  });

  test("redacts, records once per request and only new findings per session", async () => {
    const { runtime, events, deps } = setup({}, [stored({ id: 1 })]);
    const history: Array<{ role: string; content: string }> = [
      { role: "user", content: `key ${KEY} for ${INTERNAL}` },
    ];

    const first = { messages: structuredClone(history) };
    const s1 = session(1);
    const result = await runtime.redactOutbound(s1, first);
    expect(result.changed).toBe(true);
    expect(JSON.stringify(first)).not.toContain(KEY);
    expect(JSON.stringify(first)).not.toContain(INTERNAL);
    // A retry of the same request redacts again but does not record again.
    await runtime.redactOutbound(s1, { messages: structuredClone(history) });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      messageRequestId: 1,
      sessionId: "sess-1",
      userId: 7,
      keyId: 9,
      newCount: 2,
      totalCount: 2,
    });
    expect(events[0].findings[0].original).toBe(KEY);
    expect(deps.recordRuleHits).toHaveBeenCalledWith([1]);

    history.push({ role: "assistant", content: "ok" }, { role: "user", content: "next question" });
    await runtime.redactOutbound(session(2), { messages: structuredClone(history) });
    await flush();
    expect(events).toHaveLength(1);

    history.push(
      { role: "assistant", content: "ok" },
      { role: "user", content: `new ${INTERNAL}` }
    );
    await runtime.redactOutbound(session(3), { messages: structuredClone(history) });
    await flush();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ newCount: 1, totalCount: 3, requestSequence: 3 });
  });

  test("originals are masked when recordOriginals is off", async () => {
    const { runtime, events } = setup({ recordOriginals: false });
    await runtime.redactOutbound(session(1), { messages: [{ role: "user", content: KEY }] });
    await flush();
    expect(events[0].originalsRecorded).toBe(false);
    expect(events[0].findings[0].original).not.toBe(KEY);
    expect(events[0].findings[0].original).toContain("…");
  });

  test("requests without session fall back to the key scope", async () => {
    const { runtime, events } = setup();
    const noSession: RedactionSessionLike = {
      sessionId: null,
      authState: { key: { id: 3 }, user: { id: 4 } },
    };
    await runtime.redactOutbound(noSession, { messages: [{ role: "user", content: KEY }] });
    await runtime.redactOutbound({ ...noSession }, { messages: [{ role: "user", content: KEY }] });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ messageRequestId: null, userId: 4, keyId: 3 });
    await runtime.redactOutbound({}, { messages: [{ role: "user", content: KEY }] });
    await flush();
    expect(events).toHaveLength(2);
  });

  test("sync Jev discovery masks a new value in the same request", async () => {
    const { runtime, deps, events } = setup({ jev: { enabled: true, apiKey: "k", mode: "sync" } });
    deps.discovery.callJev.mockImplementation(
      async (_settings: unknown, candidates: Array<{ valueHash: string }>) => ({
        ok: true,
        durationMs: 1,
        judgements: candidates.map((candidate) => ({
          valueHash: candidate.valueHash,
          category: "secret" as const,
          confidence: 0.99,
        })),
      })
    );
    const body = { messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }] };
    const result = await runtime.redactOutbound(session(1), body);
    expect(result.discovery?.activeRules).toBe(1);
    expect(JSON.stringify(body)).not.toContain(INTERNAL);
    expect(deps.publishInvalidation).toHaveBeenCalled();
    await flush();
    expect(events[0].findings[0].ruleId).toMatch(/^jev:/);
  });

  test("async Jev discovery does not delay the request", async () => {
    const { runtime, deps } = setup({ jev: { enabled: true, apiKey: "k", mode: "async" } });
    let release: () => void = () => undefined;
    deps.discovery.callJev.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, judgements: [], durationMs: 1 });
        })
    );
    const body = { messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }] };
    const result = await runtime.redactOutbound(session(1), body);
    expect(result.discovery).toBeUndefined();
    expect(JSON.stringify(body)).toContain(INTERNAL);
    release();
  });

  test("Jev calls are recorded with what happened to each candidate", async () => {
    const { runtime, deps, jevCalls } = setup({
      jev: { enabled: true, apiKey: "k", mode: "sync", model: "jev-latest" },
    });
    deps.discovery.callJev.mockImplementation(
      async (_settings: unknown, candidates: Array<{ valueHash: string }>) => ({
        ok: true,
        durationMs: 1,
        inputTokens: 42,
        judgements: candidates.map((candidate) => ({
          valueHash: candidate.valueHash,
          category: "secret" as const,
          confidence: 0.99,
        })),
      })
    );
    await runtime.redactOutbound(session(1), {
      messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }],
    });
    await flush();
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]).toMatchObject({
      messageRequestId: 1,
      sessionId: "sess-1",
      requestSequence: 1,
      userId: 7,
      keyId: 9,
      mode: "sync",
      sendMode: "masked",
      model: "jev-latest",
      candidateCount: 1,
      judgedCount: 1,
      activeRules: 1,
      inputTokens: 42,
      timedOut: false,
      ok: true,
      error: null,
      originalsRecorded: true,
    });
    expect(jevCalls[0].results).toEqual([
      expect.objectContaining({
        value: INTERNAL,
        hint: "high_entropy",
        category: "secret",
        confidence: 0.99,
        outcome: "active",
      }),
    ]);

    // The same value is never sent again, so nothing more is recorded.
    await runtime.redactOutbound(session(2), {
      messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }],
    });
    await flush();
    expect(jevCalls).toHaveLength(1);
  });

  test("failed and slow Jev calls are recorded with masked values", async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { runtime, deps, jevCalls } = setup(
      {
        recordOriginals: false,
        jev: { enabled: true, apiKey: "k", mode: "sync", timeoutMs: 1000 },
      },
      [],
      () => clock
    );
    deps.discovery.callJev.mockImplementation(async () => {
      clock += 5000;
      return { ok: false, error: "http_500", status: 500, judgements: [], durationMs: 5000 };
    });
    await runtime.redactOutbound(session(1), {
      messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }],
    });
    await flush();
    expect(jevCalls[0]).toMatchObject({
      ok: false,
      error: "http_500",
      timedOut: true,
      durationMs: 5000,
      inputTokens: null,
      originalsRecorded: false,
    });
    expect(jevCalls[0].results[0].outcome).toBe("failed");
    expect(jevCalls[0].results[0].value).not.toBe(INTERNAL);
    // Nothing was redacted, so the Jev record triggers the retention cleanup.
    expect(deps.deleteEventsOlderThan).toHaveBeenCalledTimes(1);
  });

  test("Jev records are skipped without candidates and failures to store them are logged", async () => {
    const known = setup({ jev: { enabled: true, apiKey: "k", mode: "sync" } });
    known.deps.discovery.findCandidateVerdicts.mockImplementation(
      async (hashes: string[]) => new Set(hashes)
    );
    await known.runtime.redactOutbound(session(1), {
      messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }],
    });
    await flush();
    expect(known.deps.discovery.callJev).not.toHaveBeenCalled();
    expect(known.jevCalls).toHaveLength(0);

    const broken = setup({ jev: { enabled: true, apiKey: "k", mode: "async" } });
    broken.deps.insertJevCall.mockRejectedValue(new Error("db down"));
    await broken.runtime.redactOutbound(session(1), {
      messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }],
    });
    await vi.waitFor(() =>
      expect(broken.deps.logger.warn).toHaveBeenCalledWith(
        "[Redaction] Failed to record Jev call",
        {
          error: "db down",
        }
      )
    );

    // Without the optional dependency discovery still runs.
    const bare = setup({ jev: { enabled: true, apiKey: "k", mode: "sync" } });
    const { insertJevCall: _omit, ...withoutRecorder } = bare.deps;
    const runtime = new RedactionRuntime(withoutRecorder);
    await runtime.redactOutbound(session(1), {
      messages: [{ role: "user", content: `deploy build ${INTERNAL} now` }],
    });
    expect(bare.deps.discovery.callJev).toHaveBeenCalledTimes(1);
  });

  test("raw bodies", async () => {
    const { runtime } = setup();
    const raw = new TextEncoder().encode(
      JSON.stringify({ messages: [{ role: "user", content: KEY }] })
    ).buffer;
    const redacted = await runtime.redactRawBody(session(1), raw);
    expect(redacted).not.toBeNull();
    expect(redacted).not.toContain(KEY);
    expect(await runtime.redactRawBody(session(2), "not json")).toBeNull();
    expect(await runtime.redactRawBody(session(3), JSON.stringify({ messages: [] }))).toBeNull();
  });

  test("load failures keep the previous snapshot; settings changes apply after invalidate", async () => {
    const { runtime, deps, setSettings } = setup();
    expect((await runtime.getSnapshot())?.settings.enabled).toBe(true);
    deps.loadSettingsRow.mockRejectedValueOnce(new Error("db down"));
    runtime.invalidate();
    expect((await runtime.getSnapshot())?.settings.enabled).toBe(true);
    expect(deps.logger.error).toHaveBeenCalled();
    setSettings({ enabled: false });
    expect((await runtime.getSnapshot())?.settings.enabled).toBe(false);
    expect(runtime.currentSnapshot?.settings.enabled).toBe(false);
  });

  test("rule list order and helpers", () => {
    const settings = normalizeRedactionSettings({
      builtinOverrides: { "builtin:email": true, "builtin:jwt": false },
    });
    const list = buildRuleList(settings, [
      stored({ id: 2, source: "jev" }),
      stored({ id: 1, source: "custom" }),
      stored({ id: 3, status: "pending" }),
    ]);
    const ids = list.map((rule) => rule.id);
    expect(ids).toContain("builtin:email");
    expect(ids).not.toContain("builtin:jwt");
    expect(ids.slice(-2)).toEqual(["custom:1", "jev:2"]);
    expect(
      storedRuleToDefinition(stored({ id: 5, kind: "regex", flags: "i", groupIndex: 1 }))
    ).toMatchObject({
      id: "custom:5",
      flags: "i",
      group: 1,
    });
    expect(
      toFinding(
        {
          start: 0,
          end: 3,
          ruleId: "custom:1",
          ruleName: "r",
          category: "secret",
          original: "abcdefghij",
          replacement: "[R]",
          path: "p",
          segmentFingerprint: "f",
          contextBefore: "",
          contextAfter: "",
        },
        false
      ).original
    ).toBe("ab…j (10)");
  });
});
