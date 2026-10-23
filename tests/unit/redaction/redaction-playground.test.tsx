/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RedactionPlayground } from "@/app/[locale]/settings/redaction/_components/redaction-playground";
import type { RedactionPreview } from "@/lib/redaction/api-types";
import { redactionApi } from "@/lib/redaction/client-api";
import {
  changeValue,
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  getButton,
  okResult,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { preview: vi.fn() },
}));

const preview = vi.mocked(redactionApi.preview);

const SAMPLE = "contact alice@example.org, db at postgres://app:hunter22@db.corp/app";

const fullPreview: RedactionPreview = {
  redactedText:
    "contact [REDACTED:EMAIL#a1b2c3], db at postgres://app:[REDACTED:PASSWORD#d4e5f6]@db.corp/app",
  redactions: [
    {
      ruleId: "builtin:email",
      ruleName: "Email (server name)",
      category: "pii",
      original: "alice@example.org",
      replacement: "[REDACTED:EMAIL#a1b2c3]",
      start: 8,
      end: 25,
    },
    {
      ruleId: "custom:12",
      ruleName: "Corp DB password",
      category: "custom",
      original: "hunter22",
      replacement: "[REDACTED:PASSWORD#d4e5f6]",
      start: 51,
      end: 59,
    },
  ],
  candidates: [
    { preview: "tok_9f8e\u2026 (32)", hint: "assignment", keyName: "API_TOKEN" },
    { preview: "Zx81\u2026 (40)", hint: "high_entropy", keyName: null },
    { preview: "ftp://u:\u2026", hint: "url_credential", keyName: null },
  ],
};

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

function textarea(container: HTMLElement) {
  const element = container.querySelector("textarea");
  if (!element) throw new Error("missing textarea");
  return element;
}

describe("RedactionPlayground", () => {
  test("disables Preview until some text is entered", async () => {
    const { container } = await render(<RedactionPlayground />);

    expect(container.textContent).toContain("Run the saved rules against sample text");
    expect(textarea(container).getAttribute("placeholder")).toContain("Paste text to test");
    expect(getButton(container, "Preview").disabled).toBe(true);
    expect(container.querySelector("pre")).toBeNull();

    await changeValue(textarea(container), SAMPLE);
    expect(getButton(container, "Preview").disabled).toBe(false);
  });

  test("renders the redacted text, the masked values and the discovery candidates", async () => {
    preview.mockResolvedValue(okResult(fullPreview));
    const { container } = await render(<RedactionPlayground />);

    await changeValue(textarea(container), SAMPLE);
    await click(getButton(container, "Preview"));
    await flush();

    expect(preview).toHaveBeenCalledWith(SAMPLE);
    expect(container.textContent).toContain("Text sent upstream");
    expect(textOf(container.querySelector("pre"))).toBe(fullPreview.redactedText);

    const lists = container.querySelectorAll("ul");
    expect(lists).toHaveLength(2);
    const matches = Array.from(lists[0].querySelectorAll("li")).map(textOf);
    // Built-in rules use the localized name; custom rules keep their stored name.
    expect(matches).toEqual([
      "Email addressalice@example.org->[REDACTED:EMAIL#a1b2c3]",
      "Corp DB passwordhunter22->[REDACTED:PASSWORD#d4e5f6]",
    ]);

    expect(container.textContent).toContain("Discovery candidates");
    expect(container.textContent).toContain(
      "With Jev enabled, these values would be sent for a verdict."
    );
    const candidates = Array.from(lists[1].querySelectorAll("li")).map(textOf);
    expect(candidates).toEqual([
      "Assigned valueAPI_TOKENtok_9f8e\u2026 (32)",
      "Random-looking tokenZx81\u2026 (40)",
      "Password in URLftp://u:\u2026",
    ]);
    expect(container.textContent).not.toContain("No values would be masked.");
    expect(container.textContent).not.toContain("No candidates.");
  });

  test("shows empty-state lines when nothing matched", async () => {
    preview.mockResolvedValue(
      okResult({ redactedText: "hello world", redactions: [], candidates: [] })
    );
    const { container } = await render(<RedactionPlayground />);

    await changeValue(textarea(container), "hello world");
    await click(getButton(container, "Preview"));
    await flush();

    expect(textOf(container.querySelector("pre"))).toBe("hello world");
    expect(container.textContent).toContain("No values would be masked.");
    expect(container.textContent).toContain("No candidates.");
    expect(container.querySelectorAll("ul")).toHaveLength(0);
  });

  test("shows the running label while the preview is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.preview>>>();
    preview.mockReturnValue(pending.promise);
    const { container } = await render(<RedactionPlayground />);

    await changeValue(textarea(container), SAMPLE);
    await click(getButton(container, "Preview"));
    expect(getButton(container, "Running...").disabled).toBe(true);

    pending.resolve(okResult(fullPreview));
    await flush();
    expect(getButton(container, "Preview").disabled).toBe(false);
  });

  test("toasts the translated error and renders no result", async () => {
    preview.mockResolvedValue(errorResult("PREVIEW_FAILED"));
    const { container } = await render(<RedactionPlayground />);

    await changeValue(textarea(container), SAMPLE);
    await click(getButton(container, "Preview"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Preview failed");
    expect(container.querySelector("pre")).toBeNull();
    expect(getButton(container, "Preview").disabled).toBe(false);
  });
});
