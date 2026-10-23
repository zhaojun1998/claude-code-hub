/**
 * Redaction management operations used by the settings page and the fork REST routes
 * (`http-api.ts`). Every operation checks the caller session itself and returns an
 * `ActionResult` whose `errorCode` matches `settings.redaction.errors`.
 *
 * Lives outside `src/actions` on purpose: upstream tracks every module there in its
 * action migration matrix, and the UI reaches these through REST instead.
 */

import "server-only";

import type { ActionResult } from "@/actions/types";
import { getSession } from "@/lib/auth";
import { logger } from "@/lib/logger";
import type {
  JevTestResult,
  RedactionOverview,
  RedactionPreview,
  RuleFormInput,
} from "@/lib/redaction/api-types";
import { BUILTIN_RULES, isBuiltinRuleEnabled } from "@/lib/redaction/builtin-rules";
import { extractCandidates, maskValue } from "@/lib/redaction/candidates";
import {
  mergeSettingsUpdate,
  type PublicRedactionSettings,
  toPublicSettings,
} from "@/lib/redaction/config";
import { callJev } from "@/lib/redaction/jev-client";
import { notifyRedactionConfigChanged } from "@/lib/redaction/outbound";
import { normalizeRecordsQuery, type RecordsQueryInput } from "@/lib/redaction/records-query";
import { RULE_STATUSES, validateRuleInput } from "@/lib/redaction/rule-validation";
import { buildEngine } from "@/lib/redaction/runtime";
import * as store from "@/lib/redaction/store";
import type {
  DiscoveredRuleStatus,
  JevCallRecord,
  RecordPage,
  RedactionEventListItem,
  RedactionEventRecord,
  RedactionEventSummary,
  RedactionRecordStats,
  StoredRedactionRule,
} from "@/lib/redaction/types";

async function requireAdmin(): Promise<boolean> {
  const session = await getSession();
  return session?.user.role === "admin";
}

function failure(
  errorCode: string,
  error = errorCode
): { ok: false; error: string; errorCode: string } {
  return { ok: false, error, errorCode };
}

export async function getRedactionOverviewAction(): Promise<ActionResult<RedactionOverview>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const [{ settings }, rules, verdicts] = await Promise.all([
      store.loadSettingsRow(),
      store.listStoredRules(),
      store.countCandidateVerdicts(),
    ]);
    return {
      ok: true,
      data: {
        settings: toPublicSettings(settings),
        builtinRules: BUILTIN_RULES.map((rule) => ({
          id: rule.id,
          name: rule.name,
          category: rule.category,
          label: rule.label,
          description: rule.description ?? null,
          example: rule.example ?? null,
          enabled: isBuiltinRuleEnabled(rule, settings.builtinOverrides),
          defaultEnabled: rule.defaultEnabled !== false,
        })),
        rules,
        verdicts,
      },
    };
  } catch (error) {
    logger.error("[RedactionAction] Failed to load overview", { error });
    return failure("LOAD_FAILED");
  }
}

export async function saveRedactionSettingsAction(
  update: unknown
): Promise<ActionResult<PublicRedactionSettings>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const { settings: current } = await store.loadSettingsRow();
    const next = mergeSettingsUpdate(current, update);
    await store.saveSettings(next);
    await notifyRedactionConfigChanged();
    return { ok: true, data: toPublicSettings(next) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to save settings", { error });
    return failure("SAVE_FAILED");
  }
}

export async function setBuiltinRuleEnabledAction(
  ruleId: string,
  enabled: boolean
): Promise<ActionResult<PublicRedactionSettings>> {
  if (!BUILTIN_RULES.some((rule) => rule.id === ruleId)) return failure("RULE_NOT_FOUND");
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const { settings: current } = await store.loadSettingsRow();
    const next = mergeSettingsUpdate(current, {
      builtinOverrides: { ...current.builtinOverrides, [ruleId]: enabled },
    });
    await store.saveSettings(next);
    await notifyRedactionConfigChanged();
    return { ok: true, data: toPublicSettings(next) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to toggle built-in rule", { error, ruleId });
    return failure("SAVE_FAILED");
  }
}

export async function createRedactionRuleAction(
  input: RuleFormInput
): Promise<ActionResult<StoredRedactionRule>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const validated = validateRuleInput(input);
    if (!validated.ok) return failure(validated.errorCode);
    const created = await store.createStoredRule({
      ...validated.value,
      status: validated.value.status ?? "active",
      source: "custom",
    });
    if (!created) return failure("DUPLICATE_RULE");
    await notifyRedactionConfigChanged();
    return { ok: true, data: created };
  } catch (error) {
    logger.error("[RedactionAction] Failed to create rule", { error });
    return failure("SAVE_FAILED");
  }
}

export async function updateRedactionRuleAction(
  id: number,
  input: RuleFormInput
): Promise<ActionResult<StoredRedactionRule>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const validated = validateRuleInput(input);
    if (!validated.ok) return failure(validated.errorCode);
    const updated = await store.updateStoredRule(id, validated.value);
    if (!updated) return failure("RULE_NOT_FOUND");
    await notifyRedactionConfigChanged();
    return { ok: true, data: updated };
  } catch (error) {
    logger.error("[RedactionAction] Failed to update rule", { error, id });
    return failure("SAVE_FAILED");
  }
}

export async function setRedactionRuleStatusAction(
  id: number,
  status: DiscoveredRuleStatus
): Promise<ActionResult<StoredRedactionRule>> {
  if (!RULE_STATUSES.includes(status)) return failure("INVALID_STATUS");
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const updated = await store.updateStoredRule(id, { status });
    if (!updated) return failure("RULE_NOT_FOUND");
    await notifyRedactionConfigChanged();
    return { ok: true, data: updated };
  } catch (error) {
    logger.error("[RedactionAction] Failed to change rule status", { error, id });
    return failure("SAVE_FAILED");
  }
}

export async function deleteRedactionRuleAction(id: number): Promise<ActionResult> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const deleted = await store.deleteStoredRule(id);
    if (!deleted) return failure("RULE_NOT_FOUND");
    await notifyRedactionConfigChanged();
    return { ok: true };
  } catch (error) {
    logger.error("[RedactionAction] Failed to delete rule", { error, id });
    return failure("SAVE_FAILED");
  }
}

/** Runs the saved rules (even while redaction is disabled) against a sample text. */
export async function previewRedactionAction(
  text: string
): Promise<ActionResult<RedactionPreview>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const sample = String(text ?? "").slice(0, 100_000);
    const [{ settings, salt }, rules] = await Promise.all([
      store.loadSettingsRow(),
      store.listActiveStoredRules(),
    ]);
    const engine = buildEngine(settings, salt, rules);
    const matches = engine.findMatches(sample);
    const result = engine.redactText(sample, matches);
    return {
      ok: true,
      data: {
        redactedText: result.text,
        redactions: result.redactions,
        candidates: extractCandidates(sample, "preview", matches).map((candidate) => ({
          preview: maskValue(candidate.value),
          hint: candidate.hint,
          keyName: candidate.keyName ?? null,
        })),
      },
    };
  } catch (error) {
    logger.error("[RedactionAction] Preview failed", { error });
    return failure("PREVIEW_FAILED");
  }
}

/** Sends one synthetic candidate to Jev with the saved settings. */
export async function testJevConnectionAction(): Promise<ActionResult<JevTestResult>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const { settings } = await store.loadSettingsRow();
    const sample = "STRIPE_SECRET=sk_live_" + "8fK2mQ9vL4pX7rT1wZ3yB6nC";
    const [candidate] = extractCandidates(sample, "test");
    if (!candidate) return failure("PREVIEW_FAILED");
    const result = await callJev({ ...settings.jev, enabled: true }, [candidate]);
    const judgement = result.judgements[0];
    return {
      ok: true,
      data: {
        ok: result.ok && Boolean(judgement),
        error: result.ok ? (judgement ? undefined : "invalid_response") : result.error,
        durationMs: result.durationMs,
        model: result.model,
        category: judgement?.category,
        confidence: judgement?.confidence,
      },
    };
  } catch (error) {
    logger.error("[RedactionAction] Jev test failed", { error });
    return failure("JEV_TEST_FAILED");
  }
}

/** Forgets every Jev verdict so candidates can be judged again. */
export async function clearJevVerdictsAction(): Promise<ActionResult<{ cleared: number }>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const cleared = await store.clearCandidateVerdicts();
    await notifyRedactionConfigChanged();
    return { ok: true, data: { cleared } };
  } catch (error) {
    logger.error("[RedactionAction] Failed to clear verdicts", { error });
    return failure("SAVE_FAILED");
  }
}

function normalizeIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return [
    ...new Set(ids.filter((id): id is number => Number.isInteger(id) && (id as number) > 0)),
  ].slice(0, 500);
}

/** Redaction counts for usage log rows; non-admin users only see their own requests. */
export async function getRedactionSummariesAction(
  messageRequestIds: number[]
): Promise<ActionResult<RedactionEventSummary[]>> {
  try {
    const session = await getSession({ allowReadOnlyAccess: true });
    if (!session) return failure("PERMISSION_DENIED");
    const ids = normalizeIds(messageRequestIds);
    const userId = session.user.role === "admin" ? undefined : session.user.id;
    return { ok: true, data: await store.getEventSummaries(ids, userId) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to load summaries", { error });
    return failure("LOAD_FAILED");
  }
}

/** Totals for the redaction records page (admin only). */
export async function getRedactionRecordStatsAction(
  input?: RecordsQueryInput
): Promise<ActionResult<RedactionRecordStats>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    const { from, to } = normalizeRecordsQuery(input);
    return { ok: true, data: await store.getRedactionStats({ from, to }) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to load record stats", { error });
    return failure("LOAD_FAILED");
  }
}

export async function listRedactionEventsAction(
  input?: RecordsQueryInput
): Promise<ActionResult<RecordPage<RedactionEventListItem>>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    return { ok: true, data: await store.listRedactionEvents(normalizeRecordsQuery(input)) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to list redaction records", { error });
    return failure("LOAD_FAILED");
  }
}

export async function listJevCallsAction(
  input?: RecordsQueryInput
): Promise<ActionResult<RecordPage<JevCallRecord>>> {
  try {
    if (!(await requireAdmin())) return failure("PERMISSION_DENIED");
    return { ok: true, data: await store.listJevCalls(normalizeRecordsQuery(input)) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to list Jev calls", { error });
    return failure("LOAD_FAILED");
  }
}

export async function getRedactionEventsAction(
  messageRequestId: number
): Promise<ActionResult<RedactionEventRecord[]>> {
  try {
    const session = await getSession({ allowReadOnlyAccess: true });
    if (!session) return failure("PERMISSION_DENIED");
    if (!Number.isInteger(messageRequestId) || messageRequestId <= 0) return { ok: true, data: [] };
    const userId = session.user.role === "admin" ? undefined : session.user.id;
    return { ok: true, data: await store.getEventsForRequest(messageRequestId, userId) };
  } catch (error) {
    logger.error("[RedactionAction] Failed to load events", { error });
    return failure("LOAD_FAILED");
  }
}
