/**
 * Usage log filter "triggered redaction" (fork feature).
 *
 * Upstream query builders call `buildRedactionLogConditions` with the column that holds the
 * request id (`message_request.id`, or `usage_ledger.request_id` on ledger queries), so the
 * filter works on the list, the stats panel and the export alike.
 */

import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

export interface RedactionLogFilter {
  /** Only requests that recorded at least one redaction. */
  redactedOnly?: boolean;
}

export function buildRedactionLogConditions(
  filters: RedactionLogFilter,
  requestIdColumn: SQLWrapper
): SQL[] {
  if (!filters.redactedOnly) return [];
  return [
    sql`EXISTS (SELECT 1 FROM fork_redaction_events fre WHERE fre.message_request_id = ${requestIdColumn})`,
  ];
}
