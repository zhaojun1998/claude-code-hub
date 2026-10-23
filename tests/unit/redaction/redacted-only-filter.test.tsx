/**
 * @vitest-environment happy-dom
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { UsageLogFilters } from "@/app/[locale]/dashboard/logs/_components/filters/types";
import { RedactedOnlyFilter } from "@/app/[locale]/dashboard/logs/_components/redaction/redacted-only-filter";
import { cleanup, click, render, textOf } from "./ui-helpers";

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

function toggle(container: HTMLElement) {
  const element = container.querySelector('[role="switch"]');
  if (!element) throw new Error("switch not found");
  return element as HTMLButtonElement;
}

const otherFilters: UsageLogFilters = { model: "claude-sonnet-4", statusCode: 200, keyId: 11 };

describe("RedactedOnlyFilter", () => {
  test("renders a labelled switch that is off without the filter", async () => {
    const { container } = await render(
      <RedactedOnlyFilter filters={otherFilters} onFiltersChange={vi.fn()} />
    );

    const label = container.querySelector("label");
    expect(textOf(label)).toBe("Triggered redaction");
    expect(label?.getAttribute("for")).toBe("redacted-only-filter");
    expect(toggle(container).id).toBe("redacted-only-filter");
    expect(toggle(container).getAttribute("aria-label")).toBe("Triggered redaction");
    expect(toggle(container).getAttribute("aria-checked")).toBe("false");
  });

  test("turning it on adds the filter and keeps the others", async () => {
    const onFiltersChange = vi.fn();
    const { container } = await render(
      <RedactedOnlyFilter filters={otherFilters} onFiltersChange={onFiltersChange} />
    );

    await click(toggle(container));

    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange.mock.calls[0][0]).toStrictEqual({
      ...otherFilters,
      redactedOnly: true,
    });
  });

  test("turning it off clears the filter and keeps the others", async () => {
    const onFiltersChange = vi.fn();
    const { container } = await render(
      <RedactedOnlyFilter
        filters={{ ...otherFilters, redactedOnly: true }}
        onFiltersChange={onFiltersChange}
      />
    );

    expect(toggle(container).getAttribute("aria-checked")).toBe("true");
    await click(toggle(container));

    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange.mock.calls[0][0]).toStrictEqual({
      ...otherFilters,
      redactedOnly: undefined,
    });
  });
});
