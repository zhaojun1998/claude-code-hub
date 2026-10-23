/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RedactionFindings,
  RedactionFindingsList,
} from "@/app/[locale]/dashboard/logs/_components/redaction/redaction-findings";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionEventRecord, RedactionFinding } from "@/lib/redaction/types";
import {
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  okResult,
  queryButtons,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { getEvents: vi.fn() },
}));

const getEvents = vi.mocked(redactionApi.getEvents);

function finding(overrides: Partial<RedactionFinding>): RedactionFinding {
  return {
    ruleId: "builtin:email",
    ruleName: "Email (server name)",
    category: "pii",
    original: "alice@example.org",
    replacement: "[REDACTED:EMAIL#a1b2c3]",
    path: "messages[0].content",
    contextBefore: "",
    contextAfter: "",
    ...overrides,
  };
}

function event(overrides: Partial<RedactionEventRecord>): RedactionEventRecord {
  return {
    id: 1,
    messageRequestId: 100,
    sessionId: "sess_1",
    requestSequence: 1,
    totalCount: 0,
    newCount: 0,
    originalsRecorded: true,
    findings: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const emailFinding = finding({
  path: "messages[0].content[1].text",
  contextBefore: "mail ",
  contextAfter: " today",
});

const tokenFinding = finding({
  ruleId: "custom:7",
  ruleName: "ACME token",
  category: "custom",
  original: "acme_live_0123456789",
  replacement: "[REDACTED:ACME_TOKEN#0f0f0f]",
  path: "system",
});

const recordedEvents = [
  event({
    id: 1,
    totalCount: 4,
    newCount: 2,
    originalsRecorded: true,
    findings: [emailFinding, tokenFinding],
  }),
];

const clipboard = { writeText: vi.fn() };

beforeEach(() => {
  getEvents.mockResolvedValue(okResult(recordedEvents));
  clipboard.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

function items(container: HTMLElement) {
  return Array.from(container.querySelectorAll("li"));
}

describe("RedactionFindings", () => {
  test("shows a loading line until the events arrive", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.getEvents>>>();
    getEvents.mockReturnValue(pending.promise);
    const { container } = await render(<RedactionFindings requestId={100} />);

    expect(textOf(container)).toBe("Loading redaction records...");
    expect(getEvents).toHaveBeenCalledWith(100);

    pending.resolve(okResult(recordedEvents));
    await flush();

    expect(textOf(container)).not.toContain("Loading");
    expect(items(container)).toHaveLength(2);
  });

  test("lists original, placeholder, location and context of each finding", async () => {
    const { container } = await render(<RedactionFindings requestId={100} />);
    await flush();

    expect(container.textContent).toContain(
      "2 values newly masked in this request. 4 values were masked in total, including earlier turns of the session."
    );
    expect(container.textContent).not.toContain("were not stored");

    const [email, token] = items(container);
    expect(textOf(email.querySelector(".flex"))).toBe("Personal dataEmail address");
    const emailCodes = Array.from(email.querySelectorAll("code")).map(textOf);
    expect(emailCodes).toEqual([
      "alice@example.org",
      "[REDACTED:EMAIL#a1b2c3]",
      "messages[0].content[1].text",
      "mail [REDACTED:EMAIL#a1b2c3] today",
    ]);
    expect(textOf(email)).toContain("Original");
    expect(textOf(email)).toContain("Sent upstream");
    expect(textOf(email)).toContain("Location");
    expect(textOf(email)).toContain("Context");

    // Custom rules keep their stored name; findings without context omit that row.
    expect(textOf(token.querySelector(".flex"))).toBe("CustomACME token");
    const tokenCodes = Array.from(token.querySelectorAll("code")).map(textOf);
    expect(tokenCodes).toEqual(["acme_live_0123456789", "[REDACTED:ACME_TOKEN#0f0f0f]", "system"]);
    expect(textOf(token)).not.toContain("Context");

    expect(container.textContent).not.toContain("more values not stored");
  });

  test("sums new counts across events and reports findings that were not stored", async () => {
    getEvents.mockResolvedValue(
      okResult([
        ...recordedEvents,
        event({
          id: 2,
          totalCount: 9,
          newCount: 3,
          originalsRecorded: false,
          findings: [
            finding({
              original: "a***",
              contextBefore: "",
              contextAfter: " end",
              path: "messages[2].content",
            }),
          ],
        }),
      ])
    );
    const { container } = await render(<RedactionFindings requestId={100} />);
    await flush();

    expect(container.textContent).toContain(
      "5 values newly masked in this request. 9 values were masked in total"
    );
    expect(container.textContent).toContain(
      "Original values were not stored; a masked preview is shown."
    );
    expect(items(container)).toHaveLength(3);
    expect(textOf(items(container)[2])).toContain("[REDACTED:EMAIL#a1b2c3] end");
    expect(container.textContent).toContain("2 more values not stored");
  });

  test("copies the original value to the clipboard", async () => {
    const { container } = await render(<RedactionFindings requestId={100} />);
    await flush();

    const [, token] = items(container);
    await click(queryButtons(token, "Copy original")[0]);
    await flush();

    expect(clipboard.writeText).toHaveBeenCalledWith("acme_live_0123456789");
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });

  test("stays silent when clipboard access is denied", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denied"));
    const { container } = await render(<RedactionFindings requestId={100} />);
    await flush();

    await click(queryButtons(container, "Copy original")[0]);
    await flush();

    expect(clipboard.writeText).toHaveBeenCalledWith("alice@example.org");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  test("shows the load error when the request fails", async () => {
    getEvents.mockResolvedValue(errorResult("LOAD_FAILED"));
    const { container } = await render(<RedactionFindings requestId={100} />);
    await flush();

    expect(textOf(container)).toBe("Failed to load redaction records");
  });

  test("shows the load error when the request throws", async () => {
    getEvents.mockRejectedValue(new Error("offline"));
    const { container } = await render(<RedactionFindings requestId={100} />);
    await flush();

    expect(textOf(container)).toBe("Failed to load redaction records");
  });

  test("reloads when the request id changes and ignores stale responses", async () => {
    const first = deferred<Awaited<ReturnType<typeof redactionApi.getEvents>>>();
    const second = deferred<Awaited<ReturnType<typeof redactionApi.getEvents>>>();
    getEvents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { container, rerender } = await render(<RedactionFindings requestId={100} />);

    await rerender(<RedactionFindings requestId={200} />);
    expect(getEvents).toHaveBeenNthCalledWith(2, 200);

    second.resolve(
      okResult([event({ id: 9, newCount: 1, totalCount: 1, findings: [tokenFinding] })])
    );
    await flush();
    // The response for the previous id arrives late and must not replace the current list.
    first.resolve(okResult(recordedEvents));
    await flush();

    expect(items(container)).toHaveLength(1);
    expect(textOf(items(container)[0])).toContain("ACME token");
  });

  test("ignores a late failure after unmount", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.getEvents>>>();
    getEvents.mockReturnValue(pending.promise);
    const { unmount } = await render(<RedactionFindings requestId={100} />);

    await unmount();
    pending.reject(new Error("aborted"));
    await flush();

    expect(getEvents).toHaveBeenCalledTimes(1);
  });
});

describe("RedactionFindingsList", () => {
  test("renders findings that were already loaded without a request", async () => {
    const { container } = await render(<RedactionFindingsList events={recordedEvents} />);

    expect(getEvents).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "2 values newly masked in this request. 4 values were masked in total"
    );
    expect(items(container)).toHaveLength(2);
    expect(textOf(items(container)[0].querySelector(".flex"))).toBe("Personal dataEmail address");
    expect(textOf(items(container)[1].querySelector(".flex"))).toBe("CustomACME token");
  });

  test("shows a zero summary and no findings without records", async () => {
    const { container } = await render(<RedactionFindingsList events={[]} />);

    expect(textOf(container)).toBe(
      "0 values newly masked in this request. 0 values were masked in total, including earlier turns of the session."
    );
    expect(items(container)).toHaveLength(0);
    expect(getEvents).not.toHaveBeenCalled();
  });
});
