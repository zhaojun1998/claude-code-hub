/**
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RedactionBadge,
  RedactionDetailsSection,
  useRedactionSummary,
} from "@/app/[locale]/dashboard/logs/_components/redaction/redaction-badge";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionEventSummary } from "@/lib/redaction/types";
import { cleanup, click, errorResult, flush, okResult, render, textOf } from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { getSummaries: vi.fn(), getEvents: vi.fn() },
}));

vi.mock("@/components/ui/popover", async () => (await import("./ui-helpers")).popoverStub);

const api = vi.mocked(redactionApi);

/**
 * Summaries served by the mocked endpoint. The loader is a module singleton that caches by
 * request id, so every test uses its own ids.
 */
const summaries = new Map<number, RedactionEventSummary>();

function serve(id: number, newCount: number, totalCount: number) {
  summaries.set(id, { messageRequestId: id, newCount, totalCount });
}

/** The summary loader batches lookups behind a 50 ms timer. */
async function waitForSummaries() {
  await flush(80);
}

beforeEach(() => {
  summaries.clear();
  api.getSummaries.mockImplementation(async (ids: number[]) =>
    okResult(ids.flatMap((id) => (summaries.has(id) ? [summaries.get(id)!] : [])))
  );
  api.getEvents.mockResolvedValue(
    okResult([
      {
        id: 1,
        messageRequestId: 0,
        sessionId: null,
        requestSequence: null,
        totalCount: 7,
        newCount: 3,
        originalsRecorded: true,
        findings: [
          {
            ruleId: "builtin:jwt",
            ruleName: "JWT",
            category: "secret",
            original: "eyJhbGciOi.payload.sig",
            replacement: "[REDACTED:JWT#123abc]",
            path: "messages[1].content",
            contextBefore: "",
            contextAfter: "",
          },
        ],
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ])
  );
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

function SummaryProbe({ requestId }: { requestId: number | null | undefined }) {
  const summary = useRedactionSummary(requestId);
  return (
    <span data-testid="probe">
      {summary ? `${summary.newCount}/${summary.totalCount}` : "none"}
    </span>
  );
}

describe("RedactionBadge", () => {
  test("shows the new count with a tooltip once the summary is loaded", async () => {
    serve(101, 3, 7);
    const { container } = await render(<RedactionBadge requestId={101} />);

    // Nothing is rendered before the batched lookup resolves.
    expect(container.querySelector("button")).toBeNull();
    await waitForSummaries();

    expect(api.getSummaries).toHaveBeenCalledWith([101]);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(textOf(button)).toBe("3");
    const tooltip = "3 new values masked in this request (7 in total including earlier turns)";
    expect(button.getAttribute("title")).toBe(tooltip);
    expect(button.getAttribute("aria-label")).toBe(tooltip);
    expect(container.querySelector('[data-testid="popover-content"]')).toBeNull();
    expect(api.getEvents).not.toHaveBeenCalled();
  });

  test("opens the findings popover on click", async () => {
    serve(102, 1, 1);
    const { container } = await render(<RedactionBadge requestId={102} />);
    await waitForSummaries();

    await click(container.querySelector("button"));
    await flush();

    const content = container.querySelector('[data-testid="popover-content"]') as HTMLElement;
    expect(textOf(content.querySelector("h4"))).toBe("Redaction");
    expect(api.getEvents).toHaveBeenCalledWith(102);
    expect(textOf(content)).toContain("JSON Web Token");
    expect(textOf(content)).toContain("[REDACTED:JWT#123abc]");
  });

  test("renders nothing without a request id and never asks the server", async () => {
    const { container } = await render(
      <>
        <RedactionBadge requestId={null} />
        <RedactionBadge requestId={undefined} />
        <RedactionBadge requestId={0} />
      </>
    );
    await waitForSummaries();

    expect(container.innerHTML).toBe("");
    expect(api.getSummaries).not.toHaveBeenCalled();
  });

  test("renders nothing when the request has no summary or no new findings", async () => {
    serve(104, 0, 5);
    const { container } = await render(
      <>
        <RedactionBadge requestId={103} />
        <RedactionBadge requestId={104} />
      </>
    );
    await waitForSummaries();

    // Both rows are looked up in one batched call.
    expect(api.getSummaries).toHaveBeenCalledTimes(1);
    expect(api.getSummaries).toHaveBeenCalledWith([103, 104]);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing when the summary lookup fails", async () => {
    api.getSummaries.mockResolvedValue(errorResult("LOAD_FAILED"));
    const { container } = await render(<RedactionBadge requestId={105} />);
    await waitForSummaries();

    expect(api.getSummaries).toHaveBeenCalledWith([105]);
    expect(container.innerHTML).toBe("");
  });

  test("renders a cached summary immediately without another lookup", async () => {
    serve(106, 2, 2);
    const first = await render(<RedactionBadge requestId={106} />);
    await waitForSummaries();
    expect(api.getSummaries).toHaveBeenCalledTimes(1);
    await first.unmount();

    const second = await render(<RedactionBadge requestId={106} />);
    expect(textOf(second.container.querySelector("button"))).toBe("2");
    await waitForSummaries();
    expect(api.getSummaries).toHaveBeenCalledTimes(1);
  });
});

describe("RedactionDetailsSection", () => {
  test("shows the title and the findings list for redacted requests", async () => {
    serve(201, 3, 7);
    const { container } = await render(<RedactionDetailsSection requestId={201} />);
    await waitForSummaries();
    await flush();

    expect(textOf(container.querySelector("h4"))).toBe("Redaction");
    expect(api.getEvents).toHaveBeenCalledWith(201);
    expect(container.textContent).toContain("3 values newly masked in this request.");
    expect(container.textContent).toContain("[REDACTED:JWT#123abc]");
  });

  test("renders nothing without a summary, with zero new findings or without an id", async () => {
    serve(203, 0, 4);
    const { container } = await render(
      <>
        <RedactionDetailsSection requestId={202} />
        <RedactionDetailsSection requestId={203} />
        <RedactionDetailsSection requestId={null} />
      </>
    );
    await waitForSummaries();

    expect(container.innerHTML).toBe("");
    expect(api.getEvents).not.toHaveBeenCalled();
  });
});

describe("useRedactionSummary", () => {
  test("follows request id changes and resets to null when the id is cleared", async () => {
    serve(301, 4, 6);
    serve(302, 1, 9);
    const { container, rerender } = await render(<SummaryProbe requestId={301} />);
    const probe = () => textOf(container.querySelector('[data-testid="probe"]'));
    expect(probe()).toBe("none");

    await waitForSummaries();
    expect(probe()).toBe("4/6");

    await rerender(<SummaryProbe requestId={302} />);
    await waitForSummaries();
    expect(probe()).toBe("1/9");

    await rerender(<SummaryProbe requestId={null} />);
    expect(probe()).toBe("none");
  });

  test("ignores a summary that resolves after unmount", async () => {
    serve(303, 2, 2);
    const { unmount } = await render(<SummaryProbe requestId={303} />);

    await unmount();
    await waitForSummaries();

    expect(api.getSummaries).toHaveBeenCalledWith([303]);
  });
});
