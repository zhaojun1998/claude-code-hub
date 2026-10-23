/**
 * @vitest-environment happy-dom
 */

import fs from "node:fs";
import path from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ActiveFiltersDisplay } from "@/app/[locale]/dashboard/logs/_components/filters/active-filters-display";
import type {
  FilterDisplayNames,
  UsageLogFilters,
} from "@/app/[locale]/dashboard/logs/_components/filters/types";
import {
  cleanup,
  click,
  getButton,
  intlErrors,
  queryButtons,
  redactionMessages,
  render,
  textOf,
} from "./ui-helpers";

const dashboardMessages = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "messages/en/dashboard.json"), "utf8")
);

const displayNames: FilterDisplayNames = {
  getUserName: () => undefined,
  getKeyName: () => undefined,
  getProviderName: () => undefined,
};

function Display({
  filters,
  onRemove = vi.fn(),
  onClearAll = vi.fn(),
}: {
  filters: UsageLogFilters;
  onRemove?: (key: keyof UsageLogFilters) => void;
  onClearAll?: () => void;
}) {
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ dashboard: dashboardMessages, settings: { redaction: redactionMessages } }}
      onError={(error) => {
        intlErrors.push(`${error.code}: ${error.message}`);
      }}
    >
      <ActiveFiltersDisplay
        filters={filters}
        onRemove={onRemove}
        onClearAll={onClearAll}
        displayNames={displayNames}
        isAdmin
      />
    </NextIntlClientProvider>
  );
}

function chips(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-slot="badge"]')) as HTMLElement[];
}

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("ActiveFiltersDisplay redacted-only chip", () => {
  test("shows the chip and removes only the redacted-only filter", async () => {
    const onRemove = vi.fn();
    const { container } = await render(
      <Display filters={{ redactedOnly: true }} onRemove={onRemove} />
    );

    const [chip] = chips(container);
    expect(chips(container)).toHaveLength(1);
    expect(textOf(chip)).toBe("Triggered redaction: On");

    await click(getButton(chip, "Remove filter"));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("redactedOnly");
  });

  test("renders nothing when the filter is off", async () => {
    const { container } = await render(<Display filters={{ redactedOnly: false }} />);

    expect(container.innerHTML).toBe("");
  });

  test("lists the chip after the other filters and counts it for clear all", async () => {
    const onClearAll = vi.fn();
    const { container } = await render(
      <Display
        filters={{ model: "claude-sonnet-4", endpoint: "/v1/messages", redactedOnly: true }}
        onClearAll={onClearAll}
      />
    );

    const labels = chips(container).map(textOf);
    expect(labels).toHaveLength(3);
    expect(labels[2]).toBe("Triggered redaction: On");

    await click(getButton(container, "Clear all"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  test("omits clear all when the chip is one of only two filters", async () => {
    const { container } = await render(
      <Display filters={{ model: "claude-sonnet-4", redactedOnly: true }} />
    );

    expect(chips(container)).toHaveLength(2);
    expect(queryButtons(container, "Clear all")).toHaveLength(0);
  });
});
