/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StoredRulesTable } from "@/app/[locale]/settings/redaction/_components/stored-rules-table";
import { redactionApi } from "@/lib/redaction/client-api";
import type { StoredRedactionRule } from "@/lib/redaction/types";
import {
  changeValue,
  cleanup,
  click,
  errorResult,
  flush,
  getButton,
  makeStoredRule,
  okResult,
  queryButtons,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: {
    setRuleStatus: vi.fn(),
    deleteRule: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog", async () => (await import("./ui-helpers")).dialogStub);
vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub);

const api = vi.mocked(redactionApi);

const activeRegex = makeStoredRule({
  id: 1,
  name: "ACME token",
  category: "secret",
  label: "ACME_TOKEN",
  kind: "regex",
  pattern: "acme_[A-Za-z0-9]{32}",
  source: "custom",
  status: "active",
  confidence: null,
  hitCount: 12,
});

const pendingLiteral = makeStoredRule({
  id: 2,
  name: "Database password",
  category: "secret",
  label: "DB_PASSWORD",
  kind: "literal",
  pattern: "corp-db-password-2024",
  source: "jev",
  status: "pending",
  confidence: 0.734,
  hitCount: 3,
});

const rejectedLiteral = makeStoredRule({
  id: 3,
  name: "Office host",
  category: "network",
  label: "HOST",
  kind: "literal",
  pattern: "office-gw.lan",
  source: "jev",
  status: "rejected",
  confidence: 0.61,
  hitCount: 0,
});

const rules: StoredRedactionRule[] = [activeRegex, pendingLiteral, rejectedLiteral];

function rowOf(container: HTMLElement, name: string) {
  const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
    textOf(tr.querySelector("td")).startsWith(name)
  );
  if (!row) throw new Error(`missing row ${name}`);
  return row as HTMLTableRowElement;
}

function cellsOf(row: Element) {
  return Array.from(row.querySelectorAll("td")).map(textOf);
}

function visibleNames(container: HTMLElement) {
  return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
    textOf(tr.querySelector("td .font-medium"))
  );
}

function stubConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  vi.stubGlobal("confirm", confirm);
  return confirm;
}

beforeEach(() => {
  api.setRuleStatus.mockResolvedValue(okResult(activeRegex));
  api.deleteRule.mockResolvedValue(okResult(null));
  api.createRule.mockResolvedValue(okResult(activeRegex));
  api.updateRule.mockResolvedValue(okResult(activeRegex));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  expect(await cleanup()).toEqual([]);
});

describe("StoredRulesTable", () => {
  test("shows the empty state without rules", async () => {
    const { container } = await render(<StoredRulesTable rules={[]} onChanged={vi.fn()} />);

    expect(container.textContent).toContain(
      "Your own rules and rules discovered by Jev. Pending rules do nothing until approved."
    );
    expect(textOf(container.querySelector("tbody"))).toBe("No rules yet.");
  });

  test("renders source, kind, confidence, hits and status for each rule", async () => {
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={vi.fn()} />);

    const headers = Array.from(container.querySelectorAll("thead th")).map(textOf);
    expect(headers).toEqual([
      "Name",
      "Source",
      "Pattern",
      "Confidence",
      "Hits",
      "Status",
      "Actions",
    ]);

    const active = cellsOf(rowOf(container, "ACME token"));
    expect(active[0]).toBe("ACME tokenSecretACME_TOKEN");
    expect(active[1]).toBe("CustomRegex");
    expect(active[2]).toBe("acme_[A-Za-z0-9]{32}");
    expect(active[3]).toBe("-");
    expect(active[4]).toBe("12");
    expect(active[5]).toBe("Active");

    const pending = cellsOf(rowOf(container, "Database password"));
    expect(pending[1]).toBe("JevExact value");
    expect(pending[3]).toBe("0.73");
    expect(pending[5]).toBe("Pending review");

    const rejected = cellsOf(rowOf(container, "Office host"));
    expect(rejected[0]).toBe("Office hostNetworkHOST");
    expect(rejected[5]).toBe("Rejected");
  });

  test("offers approve only for non-active and reject only for non-rejected rules", async () => {
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={vi.fn()} />);

    const active = rowOf(container, "ACME token");
    expect(queryButtons(active, "Approve")).toHaveLength(0);
    expect(queryButtons(active, "Reject")).toHaveLength(1);

    const pending = rowOf(container, "Database password");
    expect(queryButtons(pending, "Approve")).toHaveLength(1);
    expect(queryButtons(pending, "Reject")).toHaveLength(1);

    const rejected = rowOf(container, "Office host");
    expect(queryButtons(rejected, "Approve")).toHaveLength(1);
    expect(queryButtons(rejected, "Reject")).toHaveLength(0);

    for (const row of [active, pending, rejected]) {
      expect(queryButtons(row, "Edit")).toHaveLength(1);
      expect(queryButtons(row, "Delete")).toHaveLength(1);
    }
  });

  test("filters rules by status", async () => {
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={vi.fn()} />);

    const filterLabels = ["All", "Active", "Pending", "Rejected"];
    for (const label of filterLabels) expect(queryButtons(container, label)).toHaveLength(1);
    expect(visibleNames(container)).toEqual(["ACME token", "Database password", "Office host"]);

    await click(getButton(container, "Pending"));
    expect(visibleNames(container)).toEqual(["Database password"]);

    await click(getButton(container, "Active"));
    expect(visibleNames(container)).toEqual(["ACME token"]);

    await click(getButton(container, "Rejected"));
    expect(visibleNames(container)).toEqual(["Office host"]);

    await click(getButton(container, "All"));
    expect(visibleNames(container)).toHaveLength(3);
  });

  test("shows the empty state when a filter matches nothing", async () => {
    const { container } = await render(
      <StoredRulesTable rules={[activeRegex]} onChanged={vi.fn()} />
    );

    await click(getButton(container, "Pending"));

    expect(textOf(container.querySelector("tbody"))).toBe("No rules yet.");
  });

  test("masks exact-value patterns until they are revealed", async () => {
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={vi.fn()} />);

    const row = rowOf(container, "Database password");
    const code = () => textOf(row.querySelector("code"));
    expect(code()).toBe("corp…024 (21)");
    expect(container.textContent).not.toContain("corp-db-password-2024");
    // Regex patterns are never masked and have no reveal button.
    expect(queryButtons(rowOf(container, "ACME token"), "Show")).toHaveLength(0);

    await click(getButton(row, "Show"));
    expect(code()).toBe("corp-db-password-2024");
    expect(queryButtons(row, "Show")).toHaveLength(0);

    // Revealing one literal leaves the other masked.
    expect(textOf(rowOf(container, "Office host").querySelector("code"))).toBe("off\u2026an (13)");

    await click(getButton(row, "Hide"));
    expect(code()).toBe("corp…024 (21)");
  });

  test("approving a rule sets it active, toasts and refreshes", async () => {
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "Database password"), "Approve"));
    await flush();

    expect(api.setRuleStatus).toHaveBeenCalledWith(2, "active");
    expect(toast.success).toHaveBeenCalledWith("Rule updated");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("rejecting a rule sets it rejected", async () => {
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "ACME token"), "Reject"));
    await flush();

    expect(api.setRuleStatus).toHaveBeenCalledWith(1, "rejected");
    expect(toast.success).toHaveBeenCalledWith("Rule updated");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("a failed status change shows the translated error and does not refresh", async () => {
    api.setRuleStatus.mockResolvedValue(errorResult("RULE_NOT_FOUND"));
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "Office host"), "Approve"));
    await flush();

    expect(api.setRuleStatus).toHaveBeenCalledWith(3, "active");
    expect(toast.error).toHaveBeenCalledWith("Rule not found");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("deletes a rule after confirmation", async () => {
    const confirm = stubConfirm(true);
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "Office host"), "Delete"));
    await flush();

    expect(confirm).toHaveBeenCalledWith('Delete rule "Office host"?');
    expect(api.deleteRule).toHaveBeenCalledWith(3);
    expect(toast.success).toHaveBeenCalledWith("Rule deleted");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("does not delete when the confirmation is cancelled", async () => {
    stubConfirm(false);
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "Office host"), "Delete"));
    await flush();

    expect(api.deleteRule).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("a failed delete falls back to the generic error for unknown codes", async () => {
    stubConfirm(true);
    api.deleteRule.mockResolvedValue(errorResult("internal.boom"));
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "ACME token"), "Delete"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Operation failed");
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("Add Rule opens an empty dialog that creates a rule and refreshes", async () => {
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await click(getButton(container, "Add Rule"));

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(textOf(dialog.querySelector("h2"))).toBe("Add Rule");
    expect((dialog.querySelector("#rule-name") as HTMLInputElement).value).toBe("");

    await changeValue(dialog.querySelector("#rule-name"), "Session cookie");
    await changeValue(dialog.querySelector("#rule-pattern"), "sid=[a-f0-9]{40}");
    await click(getButton(dialog, "Save"));
    await flush();

    expect(api.createRule).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Session cookie", pattern: "sid=[a-f0-9]{40}" })
    );
    expect(toast.success).toHaveBeenCalledWith("Rule created");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("Edit opens the dialog prefilled with the selected rule", async () => {
    const onChanged = vi.fn();
    const { container } = await render(<StoredRulesTable rules={rules} onChanged={onChanged} />);

    await click(getButton(rowOf(container, "Database password"), "Edit"));

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(textOf(dialog.querySelector("h2"))).toBe("Edit Rule");
    expect((dialog.querySelector("#rule-name") as HTMLInputElement).value).toBe(
      "Database password"
    );
    expect((dialog.querySelector("#rule-pattern") as HTMLTextAreaElement).value).toBe(
      "corp-db-password-2024"
    );

    await click(getButton(dialog, "Save"));
    await flush();

    expect(api.updateRule).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ name: "Database password", status: "pending" })
    );
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Opening Add after Edit starts from an empty form again.
    await click(getButton(container, "Add Rule"));
    const reopened = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(textOf(reopened.querySelector("h2"))).toBe("Add Rule");
    expect((reopened.querySelector("#rule-name") as HTMLInputElement).value).toBe("");
  });
});
