/**
 * Request-side helpers for the usage log "triggered redaction" filter (fork feature).
 * Free of server imports so the browser API client can use them.
 *
 * The filter travels as the `redactedOnly=true` query parameter on every usage log route,
 * including the export POST: its JSON body schema is strict, and keeping the fork field out
 * of it leaves the upstream OpenAPI document unchanged.
 */

export const REDACTED_ONLY_PARAM = "redactedOnly";

/** Reads the query parameter (`true`/`1`); absent or anything else means off. */
export function readRedactionLogFilter(raw: string | null | undefined): {
  redactedOnly?: boolean;
} {
  return raw === "true" || raw === "1" ? { redactedOnly: true } : {};
}

/** Moves `redactedOnly` from an export body to the query string of `path`. */
export function withRedactionExportFilter(
  path: string,
  params?: object
): { path: string; body?: object } {
  if (!params || !(REDACTED_ONLY_PARAM in params)) return { path, body: params };
  const { redactedOnly, ...body } = params as Record<string, unknown>;
  return { path: redactedOnly ? `${path}?${REDACTED_ONLY_PARAM}=true` : path, body };
}
