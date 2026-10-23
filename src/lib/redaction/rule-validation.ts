/**
 * Validation for custom redaction rules entered in the settings UI. Returns an i18n error
 * code (see `settings.redaction.errors`) on failure.
 */

import type { RuleFormInput } from "./api-types";
import { compileRuleRegex, isBroadPattern } from "./engine";
import type { DiscoveredRuleStatus, RedactionCategory, RedactionRuleKind } from "./types";

export const RULE_CATEGORIES: readonly RedactionCategory[] = ["secret", "pii", "network", "custom"];
export const RULE_KINDS: readonly RedactionRuleKind[] = ["regex", "literal"];
export const RULE_STATUSES: readonly DiscoveredRuleStatus[] = ["active", "pending", "rejected"];

function countCaptureGroups(regex: RegExp): number {
  const probe = new RegExp(`${regex.source}|`, regex.flags.replace(/[gyd]/g, ""));
  return (probe.exec("")?.length ?? 1) - 1;
}

/** Validates and normalizes a custom rule. */
export function validateRuleInput(
  input: RuleFormInput
): { ok: true; value: RuleFormInput } | { ok: false; errorCode: string } {
  const name = (input.name ?? "").trim();
  const label = (input.label ?? "").trim().toUpperCase();
  const pattern = input.kind === "literal" ? (input.pattern ?? "") : (input.pattern ?? "").trim();
  const flags = (input.flags ?? "").replace(/[^imsu]/g, "");
  const groupIndex = input.groupIndex ? Math.trunc(Number(input.groupIndex)) : 0;

  if (!name || name.length > 128) return { ok: false, errorCode: "INVALID_NAME" };
  if (!RULE_CATEGORIES.includes(input.category))
    return { ok: false, errorCode: "INVALID_CATEGORY" };
  if (!/^[A-Z0-9_]{1,48}$/.test(label)) return { ok: false, errorCode: "INVALID_LABEL" };
  if (!RULE_KINDS.includes(input.kind)) return { ok: false, errorCode: "INVALID_KIND" };
  if (!pattern || pattern.length > 4096) return { ok: false, errorCode: "INVALID_PATTERN" };
  if (input.status && !RULE_STATUSES.includes(input.status)) {
    return { ok: false, errorCode: "INVALID_STATUS" };
  }

  if (input.kind === "literal") {
    if (pattern.length < 4) return { ok: false, errorCode: "LITERAL_TOO_SHORT" };
  } else {
    const compiled = compileRuleRegex({ pattern, flags });
    if (typeof compiled === "string") return { ok: false, errorCode: "INVALID_REGEX" };
    if (isBroadPattern(compiled)) return { ok: false, errorCode: "BROAD_PATTERN" };
    if (groupIndex < 0 || groupIndex > countCaptureGroups(compiled)) {
      return { ok: false, errorCode: "INVALID_GROUP" };
    }
  }

  return {
    ok: true,
    value: {
      name,
      category: input.category,
      label,
      kind: input.kind,
      pattern,
      flags: input.kind === "regex" && flags ? flags : null,
      groupIndex: input.kind === "regex" && groupIndex > 0 ? groupIndex : null,
      description: input.description?.trim().slice(0, 500) || null,
      status: input.status ?? "active",
    },
  };
}
