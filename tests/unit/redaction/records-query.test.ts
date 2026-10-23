import { describe, expect, test } from "vitest";
import {
  normalizeRecordsQuery,
  RECORDS_DEFAULT_PAGE_SIZE,
  RECORDS_MAX_PAGE_SIZE,
  toRecordsSearch,
} from "@/lib/redaction/records-query";

describe("records query", () => {
  test("defaults", () => {
    expect(normalizeRecordsQuery()).toEqual({
      from: null,
      to: null,
      page: 1,
      pageSize: RECORDS_DEFAULT_PAGE_SIZE,
      sessionId: null,
      filter: "all",
    });
  });

  test("parses dates, numbers, session and filter", () => {
    expect(
      normalizeRecordsQuery({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
        page: "4",
        pageSize: 5,
        sessionId: `  ${"s".repeat(300)}  `,
        filter: "discovered",
      })
    ).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-02T00:00:00.000Z"),
      page: 4,
      pageSize: 5,
      sessionId: "s".repeat(256),
      filter: "discovered",
    });
  });

  test("invalid input falls back", () => {
    expect(
      normalizeRecordsQuery({
        from: "not a date",
        page: "0",
        pageSize: "9999",
        sessionId: "   ",
        filter: "everything",
      })
    ).toMatchObject({
      from: null,
      page: 1,
      pageSize: RECORDS_MAX_PAGE_SIZE,
      sessionId: null,
      filter: "all",
    });
    expect(normalizeRecordsQuery({ page: 1.5, pageSize: -1 })).toMatchObject({
      page: 1,
      pageSize: RECORDS_DEFAULT_PAGE_SIZE,
    });
  });

  test("toRecordsSearch skips empty fields", () => {
    expect(toRecordsSearch({})).toBe("");
    expect(toRecordsSearch({ from: null, to: undefined, sessionId: "" })).toBe("");
    expect(toRecordsSearch({ page: 2, filter: "failed", sessionId: "a b" })).toBe(
      "?page=2&filter=failed&sessionId=a+b"
    );
  });
});
