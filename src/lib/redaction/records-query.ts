/**
 * Query parameters of the redaction records page (`/dashboard/redaction`), shared by the
 * REST route, the service and the browser client.
 */

import type { JevCallsFilter, JevCallsQuery, RedactionEventsQuery } from "./types";

export const RECORDS_DEFAULT_PAGE_SIZE = 20;
export const RECORDS_MAX_PAGE_SIZE = 100;

const JEV_CALL_FILTERS: readonly JevCallsFilter[] = ["all", "discovered", "failed"];

/** Raw parameters as they arrive in the URL; every field is optional. */
export interface RecordsQueryInput {
  from?: string | null;
  to?: string | null;
  page?: string | number | null;
  pageSize?: string | number | null;
  sessionId?: string | null;
  filter?: string | null;
}

export type NormalizedRecordsQuery = RedactionEventsQuery & JevCallsQuery;

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseCount(raw: string | number | null | undefined, fallback: number, max: number) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

export function normalizeRecordsQuery(input: RecordsQueryInput = {}): NormalizedRecordsQuery {
  const sessionId = input.sessionId?.trim().slice(0, 256);
  const filter = JEV_CALL_FILTERS.find((item) => item === input.filter) ?? "all";
  return {
    from: parseDate(input.from),
    to: parseDate(input.to),
    page: parseCount(input.page, 1, 100_000),
    pageSize: parseCount(input.pageSize, RECORDS_DEFAULT_PAGE_SIZE, RECORDS_MAX_PAGE_SIZE),
    sessionId: sessionId || null,
    filter,
  };
}

/** Serializes the defined fields as a query string (with the leading `?`, or empty). */
export function toRecordsSearch(input: RecordsQueryInput): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
