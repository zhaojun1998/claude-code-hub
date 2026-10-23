"use client";

/**
 * Browser client for the fork redaction REST routes (see `http-api.ts`). Every call
 * resolves to an `ActionResult` whose `errorCode` matches `settings.redaction.errors`.
 */

import type { ActionResult } from "@/lib/api-client/v1/actions/types";
import { apiClient } from "@/lib/api-client/v1/client";
import { ApiError } from "@/lib/api-client/v1/errors";
import type {
  JevTestResult,
  RedactionOverview,
  RedactionPreview,
  RuleFormInput,
} from "./api-types";
import type { PublicRedactionSettings } from "./config";
import { type RecordsQueryInput, toRecordsSearch } from "./records-query";
import type {
  DiscoveredRuleStatus,
  JevCallRecord,
  RecordPage,
  RedactionEventListItem,
  RedactionEventRecord,
  RedactionEventSummary,
  RedactionRecordStats,
  StoredRedactionRule,
} from "./types";

const BASE = "/api/fork/redaction";

const AUTH_ERROR_CODES = new Set([
  "auth.missing",
  "auth.invalid",
  "auth.forbidden",
  "auth.api_key_admin_disabled",
  "auth.csrf_invalid",
]);

export function toErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) return "UNKNOWN";
  if (AUTH_ERROR_CODES.has(error.errorCode)) return "PERMISSION_DENIED";
  return error.errorCode;
}

async function call<T>(request: Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await request } as ActionResult<T>;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Request failed",
      errorCode: toErrorCode(error),
    };
  }
}

export const redactionApi = {
  getOverview: () => call(apiClient.get<RedactionOverview>(`${BASE}/overview`)),
  saveSettings: (update: Record<string, unknown>) =>
    call(apiClient.put<PublicRedactionSettings>(`${BASE}/settings`, update)),
  setBuiltinRuleEnabled: (ruleId: string, enabled: boolean) =>
    call(apiClient.put<PublicRedactionSettings>(`${BASE}/builtin-rules`, { ruleId, enabled })),
  createRule: (input: RuleFormInput) =>
    call(apiClient.post<StoredRedactionRule>(`${BASE}/rules`, input)),
  updateRule: (id: number, input: RuleFormInput) =>
    call(apiClient.put<StoredRedactionRule>(`${BASE}/rules/${id}`, input)),
  setRuleStatus: (id: number, status: DiscoveredRuleStatus) =>
    call(apiClient.put<StoredRedactionRule>(`${BASE}/rules/${id}/status`, { status })),
  deleteRule: (id: number) => call(apiClient.delete<null>(`${BASE}/rules/${id}`)),
  preview: (text: string) => call(apiClient.post<RedactionPreview>(`${BASE}/preview`, { text })),
  testJev: () => call(apiClient.post<JevTestResult>(`${BASE}/jev/test`)),
  clearJevVerdicts: () => call(apiClient.delete<{ cleared: number }>(`${BASE}/jev/verdicts`)),
  getSummaries: (ids: number[]) =>
    call(apiClient.get<RedactionEventSummary[]>(`${BASE}/summaries?ids=${ids.join(",")}`)),
  getEvents: (requestId: number) =>
    call(apiClient.get<RedactionEventRecord[]>(`${BASE}/requests/${requestId}/events`)),
  getRecordStats: (query: RecordsQueryInput = {}) =>
    call(apiClient.get<RedactionRecordStats>(`${BASE}/records/stats${toRecordsSearch(query)}`)),
  listRecordEvents: (query: RecordsQueryInput = {}) =>
    call(
      apiClient.get<RecordPage<RedactionEventListItem>>(
        `${BASE}/records/events${toRecordsSearch(query)}`
      )
    ),
  listJevCalls: (query: RecordsQueryInput = {}) =>
    call(
      apiClient.get<RecordPage<JevCallRecord>>(`${BASE}/records/jev-calls${toRecordsSearch(query)}`)
    ),
};
