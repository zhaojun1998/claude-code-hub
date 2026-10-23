/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RedactionSettingsView } from "@/app/[locale]/settings/redaction/_components/redaction-settings-view";
import type { RedactionOverview } from "@/lib/redaction/api-types";
import { redactionApi } from "@/lib/redaction/client-api";
import {
  changeValue,
  cleanup,
  click,
  errorResult,
  flush,
  getButton,
  makeBuiltinView,
  makeSettings,
  makeStoredRule,
  mouseDown,
  okResult,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: {
    getOverview: vi.fn(),
    saveSettings: vi.fn(),
    setBuiltinRuleEnabled: vi.fn(),
    setRuleStatus: vi.fn(),
    deleteRule: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    preview: vi.fn(),
    testJev: vi.fn(),
    clearJevVerdicts: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog", async () => (await import("./ui-helpers")).dialogStub);
vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub);

const api = vi.mocked(redactionApi);

function overview(partial: Partial<RedactionOverview> = {}): RedactionOverview {
  return {
    settings: makeSettings({ enabled: false }),
    builtinRules: [makeBuiltinView({ id: "builtin:email", name: "Email", enabled: false })],
    rules: [
      makeStoredRule({ id: 1, name: "ACME token", status: "active" }),
      makeStoredRule({ id: 2, name: "Jev finding A", source: "jev", status: "pending" }),
      makeStoredRule({ id: 3, name: "Jev finding B", source: "jev", status: "pending" }),
    ],
    verdicts: { sensitive: 2, benign: 9 },
    ...partial,
  };
}

function tab(container: HTMLElement, label: string) {
  const trigger = Array.from(container.querySelectorAll('[role="tab"]')).find((element) =>
    textOf(element).startsWith(label)
  );
  if (!trigger) throw new Error(`missing tab ${label}`);
  return trigger as HTMLButtonElement;
}

function activePanel(container: HTMLElement) {
  const panel = container.querySelector('[role="tabpanel"][data-state="active"]');
  if (!panel) throw new Error("no active tab panel");
  return panel as HTMLElement;
}

beforeEach(() => {
  api.getOverview.mockResolvedValue(okResult(overview()));
  api.saveSettings.mockResolvedValue(okResult(makeSettings({ enabled: true })));
  api.setRuleStatus.mockResolvedValue(okResult(makeStoredRule()));
  api.setBuiltinRuleEnabled.mockResolvedValue(okResult(makeSettings()));
  api.clearJevVerdicts.mockResolvedValue(okResult({ cleared: 11 }));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("RedactionSettingsView", () => {
  test("shows the status badge, all tabs and the pending rule count", async () => {
    const { container } = await render(<RedactionSettingsView initialOverview={overview()} />);

    expect(container.textContent).toContain("Redaction is off");
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(textOf);
    expect(tabs).toEqual([
      "General",
      "Built-in Rules",
      "Custom & Discovered2",
      "Jev Discovery",
      "Playground",
    ]);
    expect(textOf(tab(container, "Custom & Discovered").querySelector("span"))).toBe("2");

    // The General tab is open by default.
    expect(tab(container, "General").getAttribute("data-state")).toBe("active");
    expect(activePanel(container).querySelector("#redaction-enabled")).not.toBeNull();
  });

  test("shows the enabled status and no pending badge when nothing is pending", async () => {
    const { container } = await render(
      <RedactionSettingsView
        initialOverview={overview({
          settings: makeSettings({ enabled: true }),
          rules: [makeStoredRule({ id: 1, status: "active" })],
        })}
      />
    );

    expect(container.textContent).toContain("Redaction is on");
    expect(textOf(tab(container, "Custom & Discovered"))).toBe("Custom & Discovered");
    expect(tab(container, "Custom & Discovered").querySelector("span")).toBeNull();
  });

  test("each tab renders its section", async () => {
    const { container } = await render(<RedactionSettingsView initialOverview={overview()} />);

    await mouseDown(tab(container, "Built-in Rules"));
    expect(textOf(activePanel(container))).toContain("Vendor credentials");
    expect(textOf(activePanel(container))).toContain("Email address");

    await mouseDown(tab(container, "Custom & Discovered"));
    expect(textOf(activePanel(container))).toContain("Jev finding A");

    await mouseDown(tab(container, "Jev Discovery"));
    expect(textOf(activePanel(container))).toContain("Judged values: 2 sensitive, 9 benign");

    await mouseDown(tab(container, "Playground"));
    expect(activePanel(container).querySelector("textarea")).not.toBeNull();
  });

  test("refreshes the overview after a successful save", async () => {
    api.getOverview.mockResolvedValue(
      okResult(
        overview({
          settings: makeSettings({ enabled: true }),
          rules: [makeStoredRule({ id: 2, name: "Jev finding A", status: "pending" })],
        })
      )
    );
    const { container } = await render(<RedactionSettingsView initialOverview={overview()} />);

    await click(getButton(activePanel(container), "Save"));
    await flush();

    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
    expect(api.getOverview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Redaction is on");
    expect(textOf(tab(container, "Custom & Discovered").querySelector("span"))).toBe("1");
  });

  test("forms show the server-normalized values after a refresh", async () => {
    api.getOverview.mockResolvedValue(
      okResult(overview({ settings: makeSettings({ incrementalTtlHours: 1 }) }))
    );
    const { container } = await render(<RedactionSettingsView initialOverview={overview()} />);
    const ttl = () => container.querySelector("#redaction-ttl") as HTMLInputElement;

    await changeValue(ttl(), "0");
    await click(getButton(activePanel(container), "Save"));
    await flush();

    expect(api.getOverview).toHaveBeenCalledTimes(1);
    expect(ttl().value).toBe("1");
  });

  test("approving a pending rule refreshes the pending count", async () => {
    api.getOverview.mockResolvedValue(
      okResult(
        overview({
          rules: [
            makeStoredRule({ id: 1, name: "ACME token", status: "active" }),
            makeStoredRule({ id: 2, name: "Jev finding A", status: "active" }),
          ],
        })
      )
    );
    const { container } = await render(<RedactionSettingsView initialOverview={overview()} />);

    await mouseDown(tab(container, "Custom & Discovered"));
    const row = Array.from(activePanel(container).querySelectorAll("tbody tr")).find((tr) =>
      textOf(tr).startsWith("Jev finding A")
    ) as HTMLElement;
    await click(getButton(row, "Approve"));
    await flush();

    expect(api.setRuleStatus).toHaveBeenCalledWith(2, "active");
    expect(api.getOverview).toHaveBeenCalledTimes(1);
    expect(tab(container, "Custom & Discovered").querySelector("span")).toBeNull();
  });

  test("keeps the current overview when the refresh fails", async () => {
    api.getOverview.mockResolvedValue(errorResult("LOAD_FAILED"));
    const { container } = await render(<RedactionSettingsView initialOverview={overview()} />);

    await mouseDown(tab(container, "Jev Discovery"));
    await click(getButton(activePanel(container), "Forget Verdicts"));
    await flush();

    expect(toast.success).toHaveBeenCalledWith("Cleared 11 verdicts");
    expect(api.getOverview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Redaction is off");
    expect(textOf(tab(container, "Custom & Discovered").querySelector("span"))).toBe("2");
    expect(textOf(activePanel(container))).toContain("Judged values: 2 sensitive, 9 benign");
  });
});
