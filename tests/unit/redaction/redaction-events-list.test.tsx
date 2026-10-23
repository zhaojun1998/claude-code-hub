/**
 * @vitest-environment happy-dom
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RedactionEventsList } from "@/app/[locale]/dashboard/redaction/_components/redaction-events-list";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RecordPage, RedactionEventListItem, RedactionFinding } from "@/lib/redaction/types";
import {
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  getButton,
  okResult,
  queryButtons,
  redactionMessages,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: {
    getRecordStats: vi.fn(),
    listRecordEvents: vi.fn(),
    listJevCalls: vi.fn(),
    getEvents: vi.fn(),
  },
}));

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const listRecordEvents = vi.mocked(redactionApi.listRecordEvents);

type EventsResult = Awaited<ReturnType<typeof redactionApi.listRecordEvents>>;

const range = { from: "2026-10-15T12:00:00.000Z", to: "2026-10-22T12:00:00.001Z" };

function finding(overrides: Partial<RedactionFinding> = {}): RedactionFinding {
  return {
    ruleId: "builtin:email",
    ruleName: "Email (server name)",
    category: "pii",
    original: "dev@example.test",
    replacement: "[REDACTED:EMAIL#a1b2c3]",
    path: "messages[0].content",
    contextBefore: "",
    contextAfter: "",
    ...overrides,
  };
}

const fourRuleFindings = [
  finding(),
  finding({
    ruleId: "custom:7",
    ruleName: "ACME token",
    category: "custom",
    original: "acme_live_0123456789",
    replacement: "[REDACTED:ACME_TOKEN#0f0f0f]",
    path: "system",
  }),
  // A second hit of the same rule does not add another badge.
  finding({ original: "ops@example.test", path: "messages[1].content" }),
  finding({ ruleId: "jev:3", ruleName: "Jev rule", category: "secret", path: "tools[0]" }),
  finding({ ruleId: "custom:9", ruleName: "Internal host", category: "network", path: "x" }),
];

function item(overrides: Partial<RedactionEventListItem> = {}): RedactionEventListItem {
  return {
    id: 1,
    messageRequestId: 100,
    sessionId: "sess_0123456789abcdef",
    requestSequence: 2,
    totalCount: 5,
    newCount: 3,
    originalsRecorded: true,
    findings: fourRuleFindings,
    createdAt: "2026-10-01T08:30:00.000Z",
    userId: 7,
    userName: "alice",
    keyId: 11,
    keyName: "ci-key",
    model: "claude-sonnet-4",
    ...overrides,
  };
}

function page(
  items: RedactionEventListItem[],
  overrides: Partial<RecordPage<RedactionEventListItem>> = {}
): RecordPage<RedactionEventListItem> {
  return { items, page: 1, pageSize: 20, hasMore: false, ...overrides };
}

/** The top-level record rows (the findings list nests its own <li> elements). */
function rows(container: HTMLElement) {
  const list = container.querySelector("ul");
  return list ? (Array.from(list.children) as HTMLElement[]) : [];
}

function header(row: HTMLElement) {
  return row.firstElementChild as HTMLElement;
}

function ruleBadges(row: HTMLElement) {
  return Array.from(header(row).querySelectorAll('span.flex [data-slot="badge"]')).map(textOf);
}

function formatted(iso: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "UTC",
  })
    .format(new Date(iso))
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  listRecordEvents.mockResolvedValue(okResult(page([item()])));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("RedactionEventsList", () => {
  test("shows a loading line and requests the first page of the range", async () => {
    const pending = deferred<EventsResult>();
    listRecordEvents.mockReturnValue(pending.promise);
    const { container } = await render(<RedactionEventsList range={range} />);

    expect(textOf(container)).toBe(redactionMessages.records.loading);
    expect(listRecordEvents).toHaveBeenCalledWith({ ...range, page: 1, pageSize: 20 });

    pending.resolve(okResult(page([item()])));
    await flush();

    expect(rows(container)).toHaveLength(1);
  });

  test("renders time, owner, model, session and counts of each record", async () => {
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    const [row] = rows(container);
    const text = textOf(header(row));
    expect(text).toContain(formatted("2026-10-01T08:30:00.000Z"));
    expect(text).toContain("alice / ci-key");
    expect(text).toContain("claude-sonnet-4");
    expect(text).toContain("3 new / 5 total");

    const link = header(row).querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/logs?sessionId=sess_0123456789abcdef");
    expect(textOf(link)).toBe("sess_012345678... #2");
  });

  test("shows up to three rule badges and counts the rest", async () => {
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    expect(ruleBadges(rows(container)[0])).toEqual([
      "Email address",
      "ACME token",
      "Jev rule",
      "+1",
    ]);
  });

  test("different rules with the same name keep separate badges", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    listRecordEvents.mockResolvedValue(
      okResult(
        page([
          item({
            findings: [
              finding({ ruleId: "custom:1", ruleName: "Same name", category: "custom" }),
              finding({ ruleId: "custom:2", ruleName: "Same name", category: "custom" }),
            ],
          }),
        ])
      )
    );
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    expect(ruleBadges(rows(container)[0])).toEqual(["Same name", "Same name"]);
    const keyWarnings = consoleError.mock.calls.filter((args) =>
      String(args[0]).includes("same key")
    );
    expect(keyWarnings).toEqual([]);
    consoleError.mockRestore();
  });

  test("omits the overflow badge, model and session when they do not apply", async () => {
    listRecordEvents.mockResolvedValue(
      okResult(
        page([
          item({
            model: null,
            sessionId: null,
            requestSequence: null,
            userName: null,
            keyName: null,
            findings: fourRuleFindings.slice(0, 4),
          }),
        ])
      )
    );
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    const [row] = rows(container);
    expect(ruleBadges(row)).toEqual(["Email address", "ACME token", "Jev rule"]);
    expect(header(row).querySelector("a")).toBeNull();
    expect(textOf(header(row))).toContain("#7 / #11");
    expect(textOf(header(row))).not.toContain("claude-sonnet-4");
    // Only the rule badges remain; no model badge.
    expect(header(row).querySelectorAll('[data-slot="badge"]')).toHaveLength(3);
  });

  test("expands the findings of a record without another request", async () => {
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    const [row] = rows(container);
    const toggle = getButton(row, "Details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelectorAll("li")).toHaveLength(0);

    await click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(textOf(toggle)).toBe("Hide");
    expect(textOf(row)).toContain(
      "3 values newly masked in this request. 5 values were masked in total"
    );
    const findingItems = row.querySelectorAll("li");
    expect(findingItems).toHaveLength(5);
    expect(textOf(findingItems[1])).toContain("acme_live_0123456789");
    expect(textOf(findingItems[1])).toContain("[REDACTED:ACME_TOKEN#0f0f0f]");
    expect(redactionApi.getEvents).not.toHaveBeenCalled();

    await click(getButton(row, "Hide"));

    expect(row.querySelectorAll("li")).toHaveLength(0);
    expect(queryButtons(row, "Details")).toHaveLength(1);
  });

  test("says so when the range has no records", async () => {
    listRecordEvents.mockResolvedValue(okResult(page([])));
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    expect(textOf(container)).toBe("No redaction records in this range.");
    expect(queryButtons(container, "Next")).toHaveLength(0);
  });

  test("shows the load error when the request fails", async () => {
    listRecordEvents.mockResolvedValue(errorResult());
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    expect(textOf(container)).toBe("Failed to load records");
  });

  test("shows the load error when the request throws", async () => {
    listRecordEvents.mockRejectedValue(new Error("offline"));
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    expect(textOf(container)).toBe("Failed to load records");
  });

  test("pages forward and back", async () => {
    listRecordEvents.mockResolvedValue(okResult(page([item()], { hasMore: true })));
    const { container } = await render(<RedactionEventsList range={range} />);
    await flush();

    expect(textOf(container)).toContain("Page 1");
    expect(getButton(container, "Previous").disabled).toBe(true);

    listRecordEvents.mockResolvedValue(
      okResult(page([item({ id: 2, userName: "bob" })], { page: 2, hasMore: false }))
    );
    await click(getButton(container, "Next"));
    await flush();

    expect(listRecordEvents).toHaveBeenLastCalledWith({ ...range, page: 2, pageSize: 20 });
    expect(textOf(container)).toContain("Page 2");
    expect(textOf(rows(container)[0])).toContain("bob / ci-key");
    expect(getButton(container, "Next").disabled).toBe(true);

    await click(getButton(container, "Previous"));
    await flush();

    expect(listRecordEvents).toHaveBeenLastCalledWith({ ...range, page: 1, pageSize: 20 });
    expect(listRecordEvents).toHaveBeenCalledTimes(3);
  });
});
