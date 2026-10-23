/**
 * @vitest-environment happy-dom
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RecordsStats } from "@/app/[locale]/dashboard/redaction/_components/records-stats";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionRecordStats } from "@/lib/redaction/types";
import {
  cleanup,
  deferred,
  errorResult,
  flush,
  okResult,
  redactionMessages,
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

const getRecordStats = vi.mocked(redactionApi.getRecordStats);

type StatsResult = Awaited<ReturnType<typeof redactionApi.getRecordStats>>;

const range = { from: "2026-10-15T12:00:00.000Z", to: "2026-10-22T12:00:00.001Z" };

function stats(overrides: Partial<RedactionRecordStats> = {}): RedactionRecordStats {
  return {
    events: 1234,
    findings: 56,
    sessions: 7,
    jevCalls: 9,
    jevFailed: 2,
    jevTimedOut: 1,
    jevCandidates: 40,
    jevActiveRules: 3,
    jevPendingRules: 2,
    pendingReview: 4,
    topRules: [
      { ruleId: "builtin:email", ruleName: "Email (server name)", count: 12 },
      { ruleId: "custom:7", ruleName: "ACME token", count: 5 },
    ],
    ...overrides,
  };
}

/** Label, number and optional hint of each stat card. */
function cards(container: HTMLElement) {
  return Array.from(container.querySelectorAll("div.rounded-lg")).map((card) =>
    Array.from(card.querySelectorAll("p")).map(textOf)
  );
}

function badges(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-slot="badge"]')).map((badge) =>
    Array.from(badge.childNodes).map((node) => textOf(node as Element))
  );
}

beforeEach(() => {
  getRecordStats.mockResolvedValue(okResult(stats()));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("RecordsStats", () => {
  test("shows a loading line until the stats arrive", async () => {
    const pending = deferred<StatsResult>();
    getRecordStats.mockReturnValue(pending.promise);
    const { container } = await render(<RecordsStats range={range} />);

    expect(textOf(container)).toBe(redactionMessages.records.loading);
    expect(getRecordStats).toHaveBeenCalledWith(range);

    pending.resolve(okResult(stats()));
    await flush();

    expect(cards(container)).toHaveLength(4);
  });

  test("renders the stat cards with their hints", async () => {
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(cards(container)).toEqual([
      ["Requests with new redactions", (1234).toLocaleString(), "7 sessions"],
      ["Values masked (new)", "56"],
      ["Jev calls", "9", "40 candidates sent, 2 failed, 1 over the wait timeout"],
      ["Rules discovered by Jev", "5", "3 active, 2 pending review"],
    ]);
  });

  test("links pending discovered rules to the settings page", async () => {
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(textOf(container)).toContain("4 discovered rules are waiting for review");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/settings/redaction");
    expect(textOf(link)).toBe("Review rules");
  });

  test("uses singular wording for one session and one pending rule", async () => {
    getRecordStats.mockResolvedValue(okResult(stats({ sessions: 1, pendingReview: 1 })));
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(cards(container)[0][2]).toBe("1 session");
    expect(textOf(container)).toContain("1 discovered rule is waiting for review");
  });

  test("hides the review banner when nothing is pending", async () => {
    getRecordStats.mockResolvedValue(okResult(stats({ pendingReview: 0 })));
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(container.querySelector("a")).toBeNull();
    expect(textOf(container)).not.toContain("waiting for review");
  });

  test("lists the most frequent rules with localized built-in names", async () => {
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(textOf(container)).toContain("Most frequent rules");
    expect(badges(container)).toEqual([
      ["Email address", "12"],
      ["ACME token", "5"],
    ]);
    expect(textOf(container)).not.toContain("Nothing was masked in this range.");
  });

  test("says so when nothing was masked in the range", async () => {
    getRecordStats.mockResolvedValue(
      okResult(
        stats({
          events: 0,
          findings: 0,
          sessions: 0,
          pendingReview: 0,
          topRules: [],
        })
      )
    );
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(cards(container)[0]).toEqual(["Requests with new redactions", "0", "0 sessions"]);
    expect(badges(container)).toEqual([]);
    expect(textOf(container)).toContain("Nothing was masked in this range.");
  });

  test("shows the load error when the request fails", async () => {
    getRecordStats.mockResolvedValue(errorResult("RECORDS_UNAVAILABLE"));
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    const message = container.querySelector("p");
    expect(textOf(message)).toBe("Failed to load records");
    expect(message?.className).toContain("text-destructive");
  });

  test("shows the load error when the request throws", async () => {
    getRecordStats.mockRejectedValue(new Error("offline"));
    const { container } = await render(<RecordsStats range={range} />);
    await flush();

    expect(textOf(container)).toBe("Failed to load records");
  });

  test("reloads for a new range and keeps the old numbers meanwhile", async () => {
    const { container, rerender } = await render(<RecordsStats range={range} />);
    await flush();

    const pending = deferred<StatsResult>();
    getRecordStats.mockReturnValue(pending.promise);
    const nextRange = { to: "2026-10-22T13:00:00.001Z" };
    await rerender(<RecordsStats range={nextRange} />);

    expect(getRecordStats).toHaveBeenLastCalledWith(nextRange);
    expect(cards(container)[1]).toEqual(["Values masked (new)", "56"]);

    pending.resolve(okResult(stats({ findings: 99 })));
    await flush();

    expect(cards(container)[1]).toEqual(["Values masked (new)", "99"]);
  });
});
