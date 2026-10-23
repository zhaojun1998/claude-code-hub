/**
 * @vitest-environment happy-dom
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ownerLabel,
  RECORDS_PAGE_SIZE,
  RecordsMessage,
  RecordsPager,
  SessionLink,
} from "@/app/[locale]/dashboard/redaction/_components/records-shared";
import { cleanup, click, getButton, queryButtons, render, textOf } from "./ui-helpers";

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("ownerLabel", () => {
  test("uses the user and key names when they are known", () => {
    expect(ownerLabel({ userId: 7, userName: "alice", keyId: 11, keyName: "ci-key" })).toBe(
      "alice / ci-key"
    );
  });

  test("falls back to ids for deleted users or keys", () => {
    expect(ownerLabel({ userId: 7, userName: null, keyId: 11, keyName: null })).toBe("#7 / #11");
    expect(ownerLabel({ userId: 7, userName: "alice", keyId: 11, keyName: null })).toBe(
      "alice / #11"
    );
  });

  test("shows dashes when neither names nor ids exist", () => {
    expect(ownerLabel({ userId: null, userName: null, keyId: null, keyName: null })).toBe("- / -");
  });
});

describe("SessionLink", () => {
  test("renders a dash without a session", async () => {
    const { container } = await render(<SessionLink sessionId={null} sequence={3} />);

    expect(container.querySelector("a")).toBeNull();
    expect(textOf(container)).toBe("-");
  });

  test("treats an empty session id like a missing one", async () => {
    const { container } = await render(<SessionLink sessionId="" sequence={null} />);

    expect(container.querySelector("a")).toBeNull();
    expect(textOf(container)).toBe("-");
  });

  test("links short ids in full and appends the request sequence", async () => {
    const { container } = await render(<SessionLink sessionId="sess_short" sequence={3} />);

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/logs?sessionId=sess_short");
    expect(link?.getAttribute("title")).toBe("sess_short");
    expect(textOf(link)).toBe("sess_short #3");
  });

  test("keeps an id of exactly 14 characters intact", async () => {
    const { container } = await render(<SessionLink sessionId="sess_123456789" sequence={0} />);

    expect(textOf(container.querySelector("a"))).toBe("sess_123456789 #0");
  });

  test("truncates long ids and encodes them in the logs link", async () => {
    const sessionId = "session/2026 10+22-abcdef";
    const { container } = await render(<SessionLink sessionId={sessionId} sequence={null} />);

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "/dashboard/logs?sessionId=session%2F2026%2010%2B22-abcdef"
    );
    expect(link?.getAttribute("title")).toBe(sessionId);
    expect(textOf(link)).toBe("session/2026 1...");
  });
});

describe("RecordsPager", () => {
  test("renders nothing when everything fits on the first page", async () => {
    const { container } = await render(
      <RecordsPager page={1} hasMore={false} onChange={vi.fn()} />
    );

    expect(container.innerHTML).toBe("");
  });

  test("offers only the next page on the first page", async () => {
    const onChange = vi.fn();
    const { container } = await render(<RecordsPager page={1} hasMore onChange={onChange} />);

    expect(textOf(container)).toBe("PreviousPage 1Next");
    expect(getButton(container, "Previous").disabled).toBe(true);
    expect(getButton(container, "Next").disabled).toBe(false);

    await click(getButton(container, "Next"));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  test("offers only the previous page on the last page", async () => {
    const onChange = vi.fn();
    const { container } = await render(
      <RecordsPager page={3} hasMore={false} onChange={onChange} />
    );

    expect(textOf(container)).toContain("Page 3");
    expect(getButton(container, "Next").disabled).toBe(true);

    await click(getButton(container, "Previous"));
    expect(onChange).toHaveBeenCalledWith(2);
    expect(queryButtons(container, "Next")).toHaveLength(1);
  });
});

describe("RecordsMessage", () => {
  test("renders muted text by default and destructive text for errors", async () => {
    const { container } = await render(
      <>
        <RecordsMessage>Nothing here</RecordsMessage>
        <RecordsMessage tone="error">Broken</RecordsMessage>
      </>
    );

    const [info, error] = Array.from(container.querySelectorAll("p"));
    expect(textOf(info)).toBe("Nothing here");
    expect(info.className).toContain("text-muted-foreground");
    expect(info.className).not.toContain("text-destructive");
    expect(textOf(error)).toBe("Broken");
    expect(error.className).toContain("text-destructive");
  });

  test("pages hold twenty records", () => {
    expect(RECORDS_PAGE_SIZE).toBe(20);
  });
});
