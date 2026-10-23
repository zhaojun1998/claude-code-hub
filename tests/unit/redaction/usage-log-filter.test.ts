import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  buildLogsUrlQuery,
  parseLogsUrlFilters,
} from "@/app/[locale]/dashboard/logs/_utils/logs-query";
import { messageRequest, usageLedger } from "@/drizzle/schema";
import { buildRedactionLogConditions } from "@/lib/redaction/usage-log-filter";
import {
  readRedactionLogFilter,
  withRedactionExportFilter,
} from "@/lib/redaction/usage-log-params";
import { buildUsageLogConditions } from "@/repository/_shared/usage-log-filters";

const dialect = new PgDialect();

function render(condition: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(condition).sql;
}

describe("usage log filter: triggered redaction", () => {
  test("adds an EXISTS condition on the given request id column", () => {
    expect(buildRedactionLogConditions({}, messageRequest.id)).toEqual([]);
    expect(buildRedactionLogConditions({ redactedOnly: false }, messageRequest.id)).toEqual([]);

    const [onRequests] = buildRedactionLogConditions({ redactedOnly: true }, messageRequest.id);
    expect(render(onRequests)).toBe(
      'EXISTS (SELECT 1 FROM fork_redaction_events fre WHERE fre.message_request_id = "message_request"."id")'
    );
    const [onLedger] = buildRedactionLogConditions({ redactedOnly: true }, usageLedger.requestId);
    expect(render(onLedger)).toContain('fre.message_request_id = "usage_ledger"."request_id"');
  });

  test("the shared usage log conditions include it only when requested", () => {
    const without = buildUsageLogConditions({}).map(render).join(" ");
    expect(without).not.toContain("fork_redaction_events");
    const withFilter = buildUsageLogConditions({ redactedOnly: true }).map(render).join(" ");
    expect(withFilter).toContain("fork_redaction_events");
  });

  test("query parameter parsing", () => {
    expect(readRedactionLogFilter("true")).toEqual({ redactedOnly: true });
    expect(readRedactionLogFilter("1")).toEqual({ redactedOnly: true });
    expect(readRedactionLogFilter("false")).toEqual({});
    expect(readRedactionLogFilter(undefined)).toEqual({});
  });

  test("export moves the flag from the body to the query string", () => {
    const path = "/api/v1/usage-logs/exports";
    expect(withRedactionExportFilter(path)).toEqual({ path, body: undefined });
    const plain = { model: "m" };
    expect(withRedactionExportFilter(path, plain)).toEqual({ path, body: plain });
    expect(withRedactionExportFilter(path, { model: "m", redactedOnly: true })).toEqual({
      path: `${path}?redactedOnly=true`,
      body: { model: "m" },
    });
    expect(withRedactionExportFilter(path, { model: "m", redactedOnly: undefined })).toEqual({
      path,
      body: { model: "m" },
    });
  });

  test("logs page URL round trip", () => {
    expect(parseLogsUrlFilters({ redactedOnly: "true" }).redactedOnly).toBe(true);
    expect(parseLogsUrlFilters({ redactedOnly: "nope" }).redactedOnly).toBeUndefined();
    expect(parseLogsUrlFilters({}).redactedOnly).toBeUndefined();
    expect(buildLogsUrlQuery({ redactedOnly: true }).get("redactedOnly")).toBe("true");
    expect(buildLogsUrlQuery({ redactedOnly: false }).has("redactedOnly")).toBe(false);
  });
});
