import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  notify: vi.fn(async () => undefined),
  callJev: vi.fn(),
  store: {
    loadSettingsRow: vi.fn(),
    saveSettings: vi.fn(async () => undefined),
    listStoredRules: vi.fn(async () => []),
    listActiveStoredRules: vi.fn(async () => []),
    countCandidateVerdicts: vi.fn(async () => ({ sensitive: 1, benign: 2 })),
    createStoredRule: vi.fn(),
    updateStoredRule: vi.fn(),
    deleteStoredRule: vi.fn(),
    clearCandidateVerdicts: vi.fn(async () => 3),
    getEventSummaries: vi.fn(async () => []),
    getEventsForRequest: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/redaction/outbound", () => ({ notifyRedactionConfigChanged: mocks.notify }));
vi.mock("@/lib/redaction/store", () => mocks.store);
vi.mock("@/lib/redaction/jev-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/redaction/jev-client")>()),
  callJev: mocks.callJev,
}));

import {
  clearJevVerdictsAction,
  createRedactionRuleAction,
  deleteRedactionRuleAction,
  getRedactionEventsAction,
  getRedactionOverviewAction,
  getRedactionSummariesAction,
  previewRedactionAction,
  saveRedactionSettingsAction,
  setBuiltinRuleEnabledAction,
  setRedactionRuleStatusAction,
  testJevConnectionAction,
  updateRedactionRuleAction,
} from "@/lib/redaction/service";
import type { RuleFormInput } from "@/lib/redaction/api-types";
import { normalizeRedactionSettings } from "@/lib/redaction/config";
import { validateRuleInput } from "@/lib/redaction/rule-validation";

const admin = { user: { id: 1, role: "admin" } };
const member = { user: { id: 2, role: "user" } };

function form(partial: Partial<RuleFormInput> = {}): RuleFormInput {
  return {
    name: "Acme token",
    category: "secret",
    label: "acme_token",
    kind: "regex",
    pattern: "acme_[a-z0-9]{16}",
    ...partial,
  };
}

beforeEach(() => {
  mocks.getSession.mockResolvedValue(admin);
  mocks.store.loadSettingsRow.mockResolvedValue({
    settings: normalizeRedactionSettings({ enabled: true, jev: { apiKey: "secret-key-123456" } }),
    salt: "salt",
  });
});

describe("redaction service", () => {
  test("validateRuleInput", () => {
    const ok = validateRuleInput(form({ flags: "ixg", groupIndex: 0 }));
    expect(ok).toEqual({
      ok: true,
      value: expect.objectContaining({
        label: "ACME_TOKEN",
        flags: "i",
        groupIndex: null,
        status: "active",
      }),
    });
    const cases: Array<[Partial<RuleFormInput>, string]> = [
      [{ name: " " }, "INVALID_NAME"],
      [{ category: "x" as never }, "INVALID_CATEGORY"],
      [{ label: "bad label" }, "INVALID_LABEL"],
      [{ kind: "x" as never }, "INVALID_KIND"],
      [{ pattern: "" }, "INVALID_PATTERN"],
      [{ status: "x" as never }, "INVALID_STATUS"],
      [{ kind: "literal", pattern: "abc" }, "LITERAL_TOO_SHORT"],
      [{ pattern: "(" }, "INVALID_REGEX"],
      [{ pattern: ".*" }, "BROAD_PATTERN"],
      [{ pattern: "acme_([a-z]{16})", groupIndex: 2 }, "INVALID_GROUP"],
    ];
    for (const [partial, code] of cases) {
      expect(validateRuleInput(form(partial))).toEqual({ ok: false, errorCode: code });
    }
    expect(validateRuleInput(form({ pattern: "acme_([a-z]{16})", groupIndex: 1 }))).toMatchObject({
      ok: true,
      value: { groupIndex: 1 },
    });
    expect(validateRuleInput(form({ kind: "literal", pattern: " Pr0j3ct " }))).toMatchObject({
      ok: true,
      value: { pattern: " Pr0j3ct ", flags: null },
    });
  });

  test("admin-only actions reject other users", async () => {
    mocks.getSession.mockResolvedValue(member);
    for (const result of [
      await getRedactionOverviewAction(),
      await saveRedactionSettingsAction({}),
      await setBuiltinRuleEnabledAction("builtin:email", true),
      await createRedactionRuleAction(form()),
      await updateRedactionRuleAction(1, form()),
      await setRedactionRuleStatusAction(1, "active"),
      await deleteRedactionRuleAction(1),
      await previewRedactionAction("x"),
      await testJevConnectionAction(),
      await clearJevVerdictsAction(),
    ]) {
      expect(result).toMatchObject({ ok: false, errorCode: "PERMISSION_DENIED" });
    }
  });

  test("overview hides the Jev API key", async () => {
    const result = await getRedactionOverviewAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.data)).not.toContain("secret-key-123456");
    expect(result.data.settings.jev.hasApiKey).toBe(true);
    expect(result.data.builtinRules.find((rule) => rule.id === "builtin:email")?.enabled).toBe(
      false
    );
    expect(result.data.verdicts).toEqual({ sensitive: 1, benign: 2 });
    mocks.store.listStoredRules.mockRejectedValueOnce(new Error("db"));
    expect(await getRedactionOverviewAction()).toMatchObject({
      ok: false,
      errorCode: "LOAD_FAILED",
    });
  });

  test("settings and built-in toggles are saved and broadcast", async () => {
    const saved = await saveRedactionSettingsAction({ enabled: false, jev: { apiKey: "" } });
    expect(saved.ok).toBe(true);
    const persisted = mocks.store.saveSettings.mock.calls[0][0];
    expect(persisted.enabled).toBe(false);
    expect(persisted.jev.apiKey).toBe("secret-key-123456");
    expect(mocks.notify).toHaveBeenCalled();

    expect((await setBuiltinRuleEnabledAction("builtin:email", true)).ok).toBe(true);
    expect(mocks.store.saveSettings.mock.calls[1][0].builtinOverrides).toEqual({
      "builtin:email": true,
    });
    expect(await setBuiltinRuleEnabledAction("builtin:nope", true)).toMatchObject({
      errorCode: "RULE_NOT_FOUND",
    });
    mocks.store.saveSettings.mockRejectedValueOnce(new Error("db"));
    expect(await saveRedactionSettingsAction({})).toMatchObject({ errorCode: "SAVE_FAILED" });
  });

  test("rule CRUD", async () => {
    mocks.store.createStoredRule.mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(null);
    expect(await createRedactionRuleAction(form())).toMatchObject({ ok: true, data: { id: 5 } });
    expect(mocks.store.createStoredRule.mock.calls[0][0]).toMatchObject({
      source: "custom",
      status: "active",
    });
    expect(await createRedactionRuleAction(form())).toMatchObject({ errorCode: "DUPLICATE_RULE" });
    expect(await createRedactionRuleAction(form({ pattern: "(" }))).toMatchObject({
      errorCode: "INVALID_REGEX",
    });

    mocks.store.updateStoredRule.mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(null);
    expect((await updateRedactionRuleAction(5, form())).ok).toBe(true);
    expect(await updateRedactionRuleAction(6, form())).toMatchObject({
      errorCode: "RULE_NOT_FOUND",
    });
    expect(await updateRedactionRuleAction(6, form({ name: "" }))).toMatchObject({
      errorCode: "INVALID_NAME",
    });

    mocks.store.updateStoredRule
      .mockResolvedValueOnce({ id: 5, status: "active" })
      .mockResolvedValueOnce(null);
    expect((await setRedactionRuleStatusAction(5, "active")).ok).toBe(true);
    expect(await setRedactionRuleStatusAction(5, "rejected")).toMatchObject({
      errorCode: "RULE_NOT_FOUND",
    });
    expect(await setRedactionRuleStatusAction(5, "x" as never)).toMatchObject({
      errorCode: "INVALID_STATUS",
    });

    mocks.store.deleteStoredRule.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await deleteRedactionRuleAction(5)).ok).toBe(true);
    expect(await deleteRedactionRuleAction(5)).toMatchObject({ errorCode: "RULE_NOT_FOUND" });
  });

  test("preview runs saved rules and lists candidates", async () => {
    const result = await previewRedactionAction(
      "OPENAI_API_KEY=sk-proj-" +
        "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8nP0rS2uV\nbuild 7fGh2Jk9Lm4Np6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.redactedText).not.toContain("sk-proj-");
    expect(result.data.redactions[0].ruleId).toBe("builtin:openai_api_key");
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0].preview).not.toContain(
      "7fGh2Jk9Lm4Np6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef"
    );
  });

  test("Jev connection test", async () => {
    mocks.callJev.mockResolvedValueOnce({
      ok: true,
      durationMs: 12,
      model: "jev-1.13.0",
      judgements: [{ valueHash: "h", category: "secret", confidence: 0.98 }],
    });
    expect(await testJevConnectionAction()).toMatchObject({
      ok: true,
      data: { ok: true, category: "secret", confidence: 0.98, durationMs: 12 },
    });
    mocks.callJev.mockResolvedValueOnce({
      ok: false,
      error: "http_401",
      durationMs: 3,
      judgements: [],
    });
    expect(await testJevConnectionAction()).toMatchObject({
      ok: true,
      data: { ok: false, error: "http_401" },
    });
    mocks.callJev.mockResolvedValueOnce({ ok: true, durationMs: 3, judgements: [] });
    expect(await testJevConnectionAction()).toMatchObject({
      data: { ok: false, error: "invalid_response" },
    });
    mocks.callJev.mockRejectedValueOnce(new Error("boom"));
    expect(await testJevConnectionAction()).toMatchObject({ errorCode: "JEV_TEST_FAILED" });
    expect(await clearJevVerdictsAction()).toEqual({ ok: true, data: { cleared: 3 } });
  });

  test("usage log lookups are scoped to the viewer", async () => {
    await getRedactionSummariesAction([1, 1, -1, 2.5, 3] as number[]);
    expect(mocks.store.getEventSummaries).toHaveBeenLastCalledWith([1, 3], undefined);
    mocks.getSession.mockResolvedValue(member);
    await getRedactionSummariesAction([4]);
    expect(mocks.store.getEventSummaries).toHaveBeenLastCalledWith([4], 2);
    await getRedactionEventsAction(9);
    expect(mocks.store.getEventsForRequest).toHaveBeenLastCalledWith(9, 2);
    expect(await getRedactionEventsAction(-1)).toEqual({ ok: true, data: [] });
    expect(await getRedactionSummariesAction("x" as never)).toMatchObject({ ok: true });
    mocks.getSession.mockResolvedValue(null);
    expect(await getRedactionSummariesAction([1])).toMatchObject({
      errorCode: "PERMISSION_DENIED",
    });
    expect(await getRedactionEventsAction(1)).toMatchObject({ errorCode: "PERMISSION_DENIED" });
  });
});
