"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

const KNOWN_ERRORS = new Set([
  "PERMISSION_DENIED",
  "INVALID_NAME",
  "INVALID_CATEGORY",
  "INVALID_LABEL",
  "INVALID_KIND",
  "INVALID_PATTERN",
  "INVALID_STATUS",
  "LITERAL_TOO_SHORT",
  "INVALID_REGEX",
  "BROAD_PATTERN",
  "INVALID_GROUP",
  "DUPLICATE_RULE",
  "RULE_NOT_FOUND",
  "LOAD_FAILED",
  "SAVE_FAILED",
  "PREVIEW_FAILED",
  "JEV_TEST_FAILED",
]);

/** Translates an action error code into a user-facing message. */
export function useRedactionError() {
  const t = useTranslations("settings.redaction.errors");
  return useCallback(
    (result: { errorCode?: string }) =>
      t(result.errorCode && KNOWN_ERRORS.has(result.errorCode) ? result.errorCode : "UNKNOWN"),
    [t]
  );
}
