"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/** Localized display name of a redaction rule; custom and Jev rules keep their stored name. */
export function useRedactionRuleName() {
  const t = useTranslations("settings.redaction.builtinNames");
  return useCallback(
    (ruleId: string, fallback: string) => {
      const slug = ruleId.startsWith("builtin:") ? ruleId.slice("builtin:".length) : null;
      return slug && t.has(slug) ? t(slug) : fallback;
    },
    [t]
  );
}
