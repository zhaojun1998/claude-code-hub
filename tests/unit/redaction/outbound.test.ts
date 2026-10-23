import { beforeEach, describe, expect, test, vi } from "vitest";
import { normalizeRedactionSettings } from "@/lib/redaction/config";

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getRedisClient: vi.fn(() => null),
  publish: vi.fn(async () => undefined),
  subscribe: vi.fn(async () => null),
  callJev: vi.fn(),
  store: {
    loadSettingsRow: vi.fn(),
    listActiveStoredRules: vi.fn(async () => []),
    insertRedactionEvent: vi.fn(async () => undefined),
    recordRuleHits: vi.fn(async () => undefined),
    deleteEventsOlderThan: vi.fn(async () => 0),
    findCandidateVerdicts: vi.fn(async () => new Set<string>()),
    saveCandidateVerdicts: vi.fn(async () => undefined),
    createStoredRule: vi.fn(async () => null),
  },
}));

vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));
vi.mock("@/lib/redis", () => ({ getRedisClient: mocks.getRedisClient }));
vi.mock("@/lib/redis/pubsub", () => ({
  publishCacheInvalidation: mocks.publish,
  subscribeCacheInvalidation: mocks.subscribe,
}));
vi.mock("@/lib/redaction/store", () => mocks.store);
vi.mock("@/lib/redaction/jev-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/redaction/jev-client")>()),
  callJev: mocks.callJev,
}));

import {
  applyOutboundRedaction,
  applyOutboundRedactionToRaw,
  getRedactionRuntime,
  notifyRedactionConfigChanged,
  REDACTION_INVALIDATION_CHANNEL,
} from "@/lib/redaction/outbound";

const SECRET = "ghp_" + "Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz2Xc4Vb6N";
const globals = globalThis as Record<string, unknown>;

function session(id: number) {
  return { sessionId: `s-${id}`, requestSequence: 1, messageContext: { id, user: { id: 1 } } };
}

function body() {
  return { messages: [{ role: "user", content: `use ${SECRET} please` }] };
}

beforeEach(() => {
  delete globals.__CCH_REDACTION_RUNTIME__;
  delete globals.__CCH_REDACTION_SUBSCRIBED__;
  mocks.store.loadSettingsRow.mockResolvedValue({
    settings: normalizeRedactionSettings({ enabled: true }),
    salt: "salt",
  });
});

describe("outbound redaction wiring", () => {
  test("runtime is a process singleton subscribed to invalidations", async () => {
    const runtime = getRedactionRuntime();
    expect(getRedactionRuntime()).toBe(runtime);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    expect(mocks.subscribe).toHaveBeenCalledWith(
      REDACTION_INVALIDATION_CHANNEL,
      expect.any(Function)
    );

    await runtime.reload();
    expect(mocks.store.loadSettingsRow).toHaveBeenCalledTimes(1);
    const onInvalidate = (mocks.subscribe.mock.calls[0] as unknown[])[1] as () => void;
    onInvalidate();
    await runtime.getSnapshot();
    expect(mocks.store.loadSettingsRow).toHaveBeenCalledTimes(2);
  });

  test("subscription failures are logged", async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error("redis down"));
    getRedactionRuntime();
    await vi.waitFor(() =>
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        "[Redaction] Failed to subscribe to invalidation channel",
        expect.anything()
      )
    );
  });

  test("redacts the body and records the finding", async () => {
    const payload = body();
    await applyOutboundRedaction(session(1), payload);
    expect(payload.messages[0].content).not.toContain(SECRET);
    expect(payload.messages[0].content).toMatch(/\[REDACTED:GITHUB_TOKEN#[0-9a-f]{8}\]/);
    await vi.waitFor(() => expect(mocks.store.insertRedactionEvent).toHaveBeenCalledTimes(1));
    const event = (mocks.store.insertRedactionEvent.mock.calls[0] as unknown[])[0] as {
      messageRequestId: number;
      findings: Array<{ original: string }>;
    };
    expect(event.messageRequestId).toBe(1);
    expect(event.findings[0].original).toBe(SECRET);
    // Without Redis the seen-store falls back to memory, so the client was asked for.
    expect(mocks.getRedisClient).toHaveBeenCalledWith({ allowWhenRateLimitDisabled: true });
  });

  test("raw bodies are re-serialized only when something changed", async () => {
    const encoder = new TextEncoder();
    const raw = encoder.encode(JSON.stringify(body())).buffer as ArrayBuffer;
    const redacted = await applyOutboundRedactionToRaw(session(2), raw);
    expect(typeof redacted).toBe("string");
    expect(redacted as string).not.toContain(SECRET);

    const clean = encoder.encode(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))
      .buffer as ArrayBuffer;
    expect(await applyOutboundRedactionToRaw(session(3), clean)).toBe(clean);
  });

  test("internal failures fail open", async () => {
    const runtime = getRedactionRuntime();
    vi.spyOn(runtime, "redactOutbound").mockRejectedValue(new Error("boom"));
    vi.spyOn(runtime, "redactRawBody").mockRejectedValue(new Error("boom"));
    const payload = body();
    await expect(applyOutboundRedaction(session(4), payload)).resolves.toBeUndefined();
    expect(payload.messages[0].content).toContain(SECRET);
    const raw = new TextEncoder().encode("{}").buffer as ArrayBuffer;
    expect(await applyOutboundRedactionToRaw(session(5), raw)).toBe(raw);
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
  });

  test("config changes reload locally and notify other workers", async () => {
    const runtime = getRedactionRuntime();
    await runtime.reload();
    mocks.store.loadSettingsRow.mockResolvedValue({
      settings: normalizeRedactionSettings({ enabled: false }),
      salt: "salt",
    });
    await notifyRedactionConfigChanged();
    expect(runtime.currentSnapshot?.settings.enabled).toBe(false);
    expect(mocks.publish).toHaveBeenCalledWith(REDACTION_INVALIDATION_CHANNEL);

    mocks.publish.mockRejectedValueOnce(new Error("redis down"));
    await expect(notifyRedactionConfigChanged()).resolves.toBeUndefined();
  });

  test("Jev discovery goes through the injected client", async () => {
    mocks.store.loadSettingsRow.mockResolvedValue({
      settings: normalizeRedactionSettings({
        enabled: true,
        jev: { enabled: true, apiKey: "jev-key", mode: "sync", timeoutMs: 1000 },
      }),
      salt: "salt",
    });
    mocks.callJev.mockResolvedValue({ ok: true, judgements: [], durationMs: 1 });
    const payload = {
      messages: [{ role: "user", content: "trace blob 7fGh2Jk9Lm4Np6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef end" }],
    };
    await applyOutboundRedaction(session(6), payload);
    expect(mocks.callJev).toHaveBeenCalledTimes(1);
    expect(mocks.store.findCandidateVerdicts).toHaveBeenCalled();
  });
});
