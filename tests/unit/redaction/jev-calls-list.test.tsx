/**
 * @vitest-environment happy-dom
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JevCallsList } from "@/app/[locale]/dashboard/redaction/_components/jev-calls-list";
import { redactionApi } from "@/lib/redaction/client-api";
import type { JevCallRecord, JevCandidateResult, RecordPage } from "@/lib/redaction/types";
import {
  changeValue,
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  getButton,
  getSelectWithOption,
  okResult,
  queryButtons,
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

vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub);

const listJevCalls = vi.mocked(redactionApi.listJevCalls);

type CallsResult = Awaited<ReturnType<typeof redactionApi.listJevCalls>>;

const range = { from: "2026-10-15T12:00:00.000Z", to: "2026-10-22T12:00:00.001Z" };

function candidate(overrides: Partial<JevCandidateResult> = {}): JevCandidateResult {
  return {
    value: "acme_live_0123456789",
    hint: "assignment",
    keyName: "ACME_TOKEN",
    path: "messages[0].content",
    category: "secret",
    confidence: 0.934,
    outcome: "active",
    ruleIds: [12, 13],
    ...overrides,
  };
}

const results: JevCandidateResult[] = [
  candidate(),
  candidate({
    value: "build-cache-01",
    hint: "high_entropy",
    keyName: null,
    path: "system",
    category: "benign",
    confidence: null,
    outcome: "benign",
    ruleIds: [],
  }),
  candidate({
    value: "zz***",
    hint: "custom_signal",
    keyName: null,
    path: "tools[0].input",
    category: "vendor_specific",
    confidence: 0.5,
    outcome: "low_confidence",
    ruleIds: [],
  }),
  candidate({
    value: "qq***",
    hint: "url_credential",
    keyName: null,
    path: "messages[2].content",
    category: null,
    confidence: null,
    outcome: "unjudged",
    ruleIds: [],
  }),
];

function call(overrides: Partial<JevCallRecord> = {}): JevCallRecord {
  return {
    id: 1,
    messageRequestId: 100,
    sessionId: "sess_jev_1",
    requestSequence: 4,
    userId: 7,
    userName: "alice",
    keyId: 11,
    keyName: "ci-key",
    mode: "sync",
    sendMode: "masked",
    model: "jev-small",
    candidateCount: 3,
    judgedCount: 2,
    activeRules: 1,
    pendingRules: 2,
    inputTokens: 512,
    durationMs: 840,
    timedOut: false,
    ok: true,
    error: null,
    originalsRecorded: true,
    results,
    createdAt: "2026-10-02T12:00:00.000Z",
    ...overrides,
  };
}

function page(
  items: JevCallRecord[],
  overrides: Partial<RecordPage<JevCallRecord>> = {}
): RecordPage<JevCallRecord> {
  return { items, page: 1, pageSize: 20, hasMore: false, ...overrides };
}

function rows(container: HTMLElement) {
  const list = container.querySelector("ul");
  return list ? (Array.from(list.children) as HTMLElement[]) : [];
}

function header(row: HTMLElement) {
  return row.firstElementChild as HTMLElement;
}

function badges(scope: Element) {
  return Array.from(scope.querySelectorAll('[data-slot="badge"]')).map(textOf);
}

function details(row: HTMLElement) {
  return row.children[1] as HTMLElement | undefined;
}

function candidateRows(row: HTMLElement) {
  return Array.from(details(row)?.querySelectorAll("li") ?? []);
}

beforeEach(() => {
  listJevCalls.mockResolvedValue(okResult(page([call()])));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("JevCallsList", () => {
  test("shows a loading line and requests all calls of the range", async () => {
    const pending = deferred<CallsResult>();
    listJevCalls.mockReturnValue(pending.promise);
    const { container } = await render(<JevCallsList range={range} />);

    expect(textOf(container)).toContain(redactionMessages.records.loading);
    expect(listJevCalls).toHaveBeenCalledWith({
      ...range,
      filter: "all",
      page: 1,
      pageSize: 20,
    });

    pending.resolve(okResult(page([call()])));
    await flush();

    expect(rows(container)).toHaveLength(1);
  });

  test("offers the call filters", async () => {
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    const select = getSelectWithOption(container, "discovered");
    expect(select.value).toBe("all");
    expect(Array.from(select.options).map((option) => [option.value, textOf(option)])).toEqual([
      ["all", "All calls"],
      ["discovered", "Discovered rules"],
      ["failed", "Failed calls"],
    ]);
  });

  test("renders the call summary with rule badges and status", async () => {
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    const [row] = rows(container);
    const text = textOf(header(row));
    expect(text).toContain("alice / ci-key");
    expect(text).toContain("jev-small · Sync · Shape only");
    expect(text).toContain("3 candidates, 2 judged");
    expect(text).toContain("840 ms");
    expect(badges(header(row))).toEqual(["1 active", "2 pending", "OK"]);

    const link = header(row).querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/logs?sessionId=sess_jev_1");
    expect(textOf(link)).toBe("sess_jev_1 #4");
  });

  test("labels async calls that sent full values and calls without a model", async () => {
    listJevCalls.mockResolvedValue(
      okResult(
        page([
          call({
            mode: "async",
            sendMode: "full",
            model: null,
            activeRules: 0,
            pendingRules: 0,
            sessionId: null,
          }),
        ])
      )
    );
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    const [row] = rows(container);
    expect(textOf(header(row))).toContain("- · Async · Full value");
    expect(badges(header(row))).toEqual(["OK"]);
    expect(header(row).querySelector("a")).toBeNull();
  });

  test("marks failed and timed-out calls", async () => {
    listJevCalls.mockResolvedValue(
      okResult(
        page([
          call({ id: 1, ok: false, timedOut: true, error: "upstream 502" }),
          call({ id: 2, ok: true, timedOut: true }),
          call({ id: 3, ok: true, timedOut: false }),
        ])
      )
    );
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    const statuses = rows(container).map((row) => badges(header(row)).at(-1));
    expect(statuses).toEqual(["Failed", "Over the wait timeout", "OK"]);
  });

  test("expands a call into its error, token usage and candidate results", async () => {
    listJevCalls.mockResolvedValue(
      okResult(page([call({ ok: false, error: "upstream 502", originalsRecorded: false })]))
    );
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    const [row] = rows(container);
    const toggle = getButton(row, "Details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details(row)).toBeUndefined();

    await click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(textOf(toggle)).toBe("Hide");
    const panel = textOf(details(row));
    expect(panel).toContain("Error: upstream 502");
    expect(panel).toContain("512 input tokens");
    expect(panel).toContain("Original values were not stored; masked previews are shown.");

    const [active, benign, lowConfidence, unjudged] = candidateRows(row);
    expect(candidateRows(row)).toHaveLength(4);

    expect(badges(active)).toEqual(["Rule created (active)", "Secret"]);
    expect(textOf(active)).toContain("93% confidence");
    expect(textOf(active)).toContain("Rules #12, #13");
    expect(textOf(active)).toContain("Valueacme_live_0123456789");
    expect(textOf(active)).toContain("SignalAssigned value (ACME_TOKEN)");
    expect(textOf(active)).toContain("Locationmessages[0].content");

    // Known categories and hints are localized; confidence and rules are optional.
    expect(badges(benign)).toEqual(["Judged benign", "Benign"]);
    expect(textOf(benign)).toContain("SignalRandom-looking token");
    expect(textOf(benign)).not.toContain("confidence");
    expect(textOf(benign)).not.toContain("Rules #");

    // Unknown categories and hints fall back to the raw identifiers.
    expect(badges(lowConfidence)).toEqual(["Below the suggestion threshold", "vendor_specific"]);
    expect(textOf(lowConfidence)).toContain("50% confidence");
    expect(textOf(lowConfidence)).toContain("Signalcustom_signal");

    // Without a category only the outcome badge is shown.
    expect(badges(unjudged)).toEqual(["No verdict returned"]);
    expect(textOf(unjudged)).toContain("SignalPassword in URL");

    await click(getButton(row, "Hide"));
    expect(details(row)).toBeUndefined();
  });

  test("omits the optional detail lines when they do not apply", async () => {
    listJevCalls.mockResolvedValue(
      okResult(
        page([
          call({
            inputTokens: null,
            error: null,
            originalsRecorded: true,
            results: [candidate({ outcome: "failed", category: null, confidence: null })],
          }),
        ])
      )
    );
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    const [row] = rows(container);
    await click(getButton(row, "Details"));

    const panel = textOf(details(row));
    expect(panel).not.toContain("Error:");
    expect(panel).not.toContain("input tokens");
    expect(panel).not.toContain("were not stored");
    expect(badges(candidateRows(row)[0])).toEqual(["Call failed"]);
  });

  test("shows the empty state with a hint", async () => {
    listJevCalls.mockResolvedValue(okResult(page([])));
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    expect(textOf(container)).toContain("No Jev calls in this range.");
    expect(textOf(container)).toContain(
      redactionMessages.records.jev.emptyHint.replace(/\s+/g, " ")
    );
    expect(queryButtons(container, "Next")).toHaveLength(0);
  });

  test("keeps the filter visible when loading fails", async () => {
    listJevCalls.mockResolvedValue(errorResult());
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    expect(textOf(container)).toContain("Failed to load records");
    expect(getSelectWithOption(container, "failed")).toBeTruthy();
    expect(queryButtons(container, "Next")).toHaveLength(0);
  });

  test("shows the load error when the request throws", async () => {
    listJevCalls.mockRejectedValue(new Error("offline"));
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    expect(textOf(container)).toContain("Failed to load records");
  });

  test("pages forward and back", async () => {
    listJevCalls.mockResolvedValue(okResult(page([call()], { hasMore: true })));
    const { container } = await render(<JevCallsList range={range} />);
    await flush();

    expect(textOf(container)).toContain("Page 1");
    await click(getButton(container, "Next"));
    await flush();

    expect(listJevCalls).toHaveBeenLastCalledWith({
      ...range,
      filter: "all",
      page: 2,
      pageSize: 20,
    });
    expect(textOf(container)).toContain("Page 2");

    await click(getButton(container, "Previous"));
    await flush();

    expect(listJevCalls).toHaveBeenLastCalledWith({
      ...range,
      filter: "all",
      page: 1,
      pageSize: 20,
    });
  });

  test("changing the filter reloads from the first page", async () => {
    listJevCalls.mockResolvedValue(okResult(page([call()], { hasMore: true })));
    const { container } = await render(<JevCallsList range={range} />);
    await flush();
    await click(getButton(container, "Next"));
    await flush();
    expect(textOf(container)).toContain("Page 2");

    listJevCalls.mockResolvedValue(okResult(page([call({ id: 5, userName: "bob" })])));
    await changeValue(getSelectWithOption(container, "discovered"), "discovered");
    await flush();

    expect(listJevCalls).toHaveBeenLastCalledWith({
      ...range,
      filter: "discovered",
      page: 1,
      pageSize: 20,
    });
    expect(getSelectWithOption(container, "discovered").value).toBe("discovered");
    expect(textOf(container)).not.toContain("Page 2");
    expect(textOf(rows(container)[0])).toContain("bob / ci-key");

    await changeValue(getSelectWithOption(container, "failed"), "failed");
    await flush();

    expect(listJevCalls).toHaveBeenLastCalledWith({
      ...range,
      filter: "failed",
      page: 1,
      pageSize: 20,
    });
  });
});
