/**
 * @vitest-environment happy-dom
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildRecordsRange,
  RedactionRecordsView,
} from "@/app/[locale]/dashboard/redaction/_components/redaction-records-view";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionRecordStats } from "@/lib/redaction/types";
import {
  changeValue,
  cleanup,
  click,
  flush,
  getButton,
  getSelectWithOption,
  mouseDown,
  okResult,
  render,
  textOf,
} from "./ui-helpers";

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

vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub);

const api = vi.mocked(redactionApi);

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const emptyStats: RedactionRecordStats = {
  events: 0,
  findings: 0,
  sessions: 0,
  jevCalls: 0,
  jevFailed: 0,
  jevTimedOut: 0,
  jevCandidates: 0,
  jevActiveRules: 0,
  jevPendingRules: 0,
  pendingReview: 0,
  topRules: [],
};

function emptyPage() {
  return { items: [], page: 1, pageSize: 20, hasMore: false };
}

function tab(container: HTMLElement, label: string) {
  const trigger = Array.from(container.querySelectorAll('[role="tab"]')).find(
    (element) => textOf(element) === label
  );
  if (!trigger) throw new Error(`missing tab ${label}`);
  return trigger;
}

function activePanel(container: HTMLElement) {
  const panel = container.querySelector('[role="tabpanel"][data-state="active"]');
  if (!panel) throw new Error("no active tab panel");
  return panel as HTMLElement;
}

function rangeSelect(container: HTMLElement) {
  return getSelectWithOption(container, "30d");
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  api.getRecordStats.mockResolvedValue(okResult(emptyStats));
  api.listRecordEvents.mockResolvedValue(okResult(emptyPage()));
  api.listJevCalls.mockResolvedValue(okResult(emptyPage()));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("buildRecordsRange", () => {
  test("starts each bounded range the right amount of time before now", () => {
    expect(buildRecordsRange("24h", NOW)).toEqual({
      from: new Date(NOW - 24 * HOUR).toISOString(),
      to: "2026-10-22T12:00:00.001Z",
    });
    expect(buildRecordsRange("7d", NOW).from).toBe("2026-10-15T12:00:00.000Z");
    expect(buildRecordsRange("30d", NOW).from).toBe("2026-09-22T12:00:00.000Z");
  });

  test("leaves the start open for all time", () => {
    const range = buildRecordsRange("all", NOW);
    expect(range.from).toBeUndefined();
    expect(range.to).toBe("2026-10-22T12:00:00.001Z");
  });
});

describe("RedactionRecordsView", () => {
  test("loads the last seven days by default and opens the records tab", async () => {
    const { container } = await render(<RedactionRecordsView />);
    await flush();

    const select = rangeSelect(container);
    expect(select.value).toBe("7d");
    expect(Array.from(select.options).map(textOf)).toEqual([
      "Last 24 hours",
      "Last 7 days",
      "Last 30 days",
      "All time",
    ]);

    const range = buildRecordsRange("7d", NOW);
    expect(api.getRecordStats).toHaveBeenCalledWith(range);
    expect(api.listRecordEvents).toHaveBeenCalledWith({ ...range, page: 1, pageSize: 20 });
    expect(api.listJevCalls).not.toHaveBeenCalled();

    const settingsLink = container.querySelector('a[href="/settings/redaction"]');
    expect(textOf(settingsLink)).toBe("Redaction settings");

    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(textOf);
    expect(tabs).toEqual(["Redaction records", "Jev discovery"]);
    expect(tab(container, "Redaction records").getAttribute("data-state")).toBe("active");
    expect(textOf(activePanel(container))).toBe("No redaction records in this range.");
  });

  test("switching the range reloads the stats and restarts the records at page one", async () => {
    api.listRecordEvents.mockResolvedValue(okResult({ ...emptyPage(), hasMore: true }));
    const { container } = await render(<RedactionRecordsView />);
    await flush();

    await click(getButton(container, "Next"));
    await flush();
    expect(api.listRecordEvents).toHaveBeenLastCalledWith({
      ...buildRecordsRange("7d", NOW),
      page: 2,
      pageSize: 20,
    });

    await changeValue(rangeSelect(container), "30d");
    await flush();

    const range = buildRecordsRange("30d", NOW);
    expect(rangeSelect(container).value).toBe("30d");
    expect(api.getRecordStats).toHaveBeenLastCalledWith(range);
    expect(api.listRecordEvents).toHaveBeenLastCalledWith({ ...range, page: 1, pageSize: 20 });
    expect(textOf(container)).toContain("Page 1");
  });

  test("all time queries without a start", async () => {
    const { container } = await render(<RedactionRecordsView />);
    await flush();

    await changeValue(rangeSelect(container), "all");
    await flush();

    const [query] = api.getRecordStats.mock.lastCall ?? [];
    expect(query).toEqual({ from: undefined, to: "2026-10-22T12:00:00.001Z" });
  });

  test("refresh moves the end of the range to now and keeps the current page", async () => {
    api.listRecordEvents.mockResolvedValue(okResult({ ...emptyPage(), hasMore: true }));
    const { container } = await render(<RedactionRecordsView />);
    await flush();
    await click(getButton(container, "Next"));
    await flush();

    const later = NOW + 5 * 60 * 1000;
    vi.mocked(Date.now).mockReturnValue(later);
    await click(getButton(container, "Refresh"));
    await flush();

    const range = buildRecordsRange("7d", later);
    expect(api.getRecordStats).toHaveBeenLastCalledWith(range);
    expect(api.getRecordStats).toHaveBeenCalledTimes(2);
    expect(api.listRecordEvents).toHaveBeenLastCalledWith({ ...range, page: 2, pageSize: 20 });
  });

  test("the Jev tab loads the discovery calls of the same range", async () => {
    const { container } = await render(<RedactionRecordsView />);
    await flush();

    await mouseDown(tab(container, "Jev discovery"));
    await flush();

    expect(tab(container, "Jev discovery").getAttribute("data-state")).toBe("active");
    expect(api.listJevCalls).toHaveBeenCalledWith({
      ...buildRecordsRange("7d", NOW),
      filter: "all",
      page: 1,
      pageSize: 20,
    });
    expect(textOf(activePanel(container))).toContain("No Jev calls in this range.");

    await changeValue(rangeSelect(container), "24h");
    await flush();

    expect(api.listJevCalls).toHaveBeenLastCalledWith({
      ...buildRecordsRange("24h", NOW),
      filter: "all",
      page: 1,
      pageSize: 20,
    });
  });
});
