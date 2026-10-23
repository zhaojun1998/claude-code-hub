/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BuiltinRulesTable } from "@/app/[locale]/settings/redaction/_components/builtin-rules-table";
import type { BuiltinRuleView } from "@/lib/redaction/api-types";
import { BUILTIN_RULES } from "@/lib/redaction/builtin-rules";
import { redactionApi } from "@/lib/redaction/client-api";
import {
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  makeBuiltinView,
  makeSettings,
  okResult,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { setBuiltinRuleEnabled: vi.fn() },
}));

const setBuiltinRuleEnabled = vi.mocked(redactionApi.setBuiltinRuleEnabled);

const pem = makeBuiltinView({
  id: "builtin:private_key_pem",
  name: "Server-side PEM name",
  category: "secret",
  label: "PRIVATE_KEY",
  example: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  enabled: true,
  defaultEnabled: true,
});

const email = makeBuiltinView({
  id: "builtin:email",
  name: "Server-side email name",
  category: "pii",
  label: "EMAIL",
  example: null,
  enabled: false,
  defaultEnabled: false,
});

const retired = makeBuiltinView({
  id: "builtin:retired_rule_without_translation",
  name: "Retired rule",
  category: "network",
  label: "HOST",
  example: "db01.corp",
  enabled: false,
  defaultEnabled: false,
});

const rules: BuiltinRuleView[] = [pem, email, retired];

function rowOf(container: HTMLElement, name: string) {
  const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
    textOf(tr.querySelector("td")).startsWith(name)
  );
  if (!row) throw new Error(`missing row ${name}`);
  return row;
}

function switchOf(container: HTMLElement, name: string) {
  const element = container.querySelector<HTMLButtonElement>(
    `button[role="switch"][aria-label="${name}"]`
  );
  if (!element) throw new Error(`missing switch ${name}`);
  return element;
}

beforeEach(() => {
  setBuiltinRuleEnabled.mockResolvedValue(okResult(makeSettings()));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("BuiltinRulesTable", () => {
  test("renders headers and one row per rule with localized names", async () => {
    const { container } = await render(<BuiltinRulesTable rules={rules} onChanged={vi.fn()} />);

    const headers = Array.from(container.querySelectorAll("thead th")).map(textOf);
    expect(headers).toEqual(["Rule", "Category", "Placeholder label", "Example", "Enabled"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);

    const pemRow = rowOf(container, "Private key (PEM block)");
    const cells = Array.from(pemRow.querySelectorAll("td")).map(textOf);
    expect(cells[0]).toBe("Private key (PEM block)Default on");
    expect(cells[1]).toBe("Secret");
    expect(cells[2]).toBe("PRIVATE_KEY");
    // Only the first line of a multi-line example is shown.
    expect(cells[3]).toBe("-----BEGIN " + "RSA PRIVATE KEY-----");
    expect(switchOf(container, "Private key (PEM block)").getAttribute("aria-checked")).toBe(
      "true"
    );

    const emailCells = Array.from(rowOf(container, "Email address").querySelectorAll("td")).map(
      textOf
    );
    expect(emailCells[0]).toBe("Email addressDefault off");
    expect(emailCells[1]).toBe("Personal data");
    expect(emailCells[3]).toBe("");
    expect(switchOf(container, "Email address").getAttribute("aria-checked")).toBe("false");

    // Unknown built-in slugs keep the server-provided name.
    const retiredCells = Array.from(rowOf(container, "Retired rule").querySelectorAll("td")).map(
      textOf
    );
    expect(retiredCells[1]).toBe("Network");
    expect(retiredCells[3]).toBe("db01.corp");
  });

  test("every shipped built-in rule has a localized name and category", async () => {
    const views = BUILTIN_RULES.map((rule) =>
      makeBuiltinView({
        id: rule.id,
        name: `raw:${rule.id}`,
        category: rule.category,
        label: rule.label,
        example: rule.example ?? null,
        enabled: rule.defaultEnabled ?? true,
        defaultEnabled: rule.defaultEnabled ?? true,
      })
    );
    const { container } = await render(<BuiltinRulesTable rules={views} onChanged={vi.fn()} />);

    expect(container.querySelectorAll("tbody tr")).toHaveLength(BUILTIN_RULES.length);
    expect(container.textContent).not.toContain("raw:builtin:");
  });

  test("toggling a rule saves it, toasts and calls onChanged", async () => {
    const onChanged = vi.fn();
    const { container } = await render(<BuiltinRulesTable rules={rules} onChanged={onChanged} />);

    await click(switchOf(container, "Email address"));
    await flush();

    expect(setBuiltinRuleEnabled).toHaveBeenCalledWith("builtin:email", true);
    expect(toast.success).toHaveBeenCalledWith("Rule updated");
    expect(onChanged).toHaveBeenCalledTimes(1);

    await click(switchOf(container, "Private key (PEM block)"));
    await flush();

    expect(setBuiltinRuleEnabled).toHaveBeenLastCalledWith("builtin:private_key_pem", false);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  test("disables only the switch of the rule being saved", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.setBuiltinRuleEnabled>>>();
    setBuiltinRuleEnabled.mockReturnValue(pending.promise);
    const { container } = await render(<BuiltinRulesTable rules={rules} onChanged={vi.fn()} />);

    await click(switchOf(container, "Email address"));

    expect(switchOf(container, "Email address").disabled).toBe(true);
    expect(switchOf(container, "Private key (PEM block)").disabled).toBe(false);

    pending.resolve(okResult(makeSettings()));
    await flush();

    expect(switchOf(container, "Email address").disabled).toBe(false);
  });

  test("shows the translated error and skips onChanged when saving fails", async () => {
    setBuiltinRuleEnabled.mockResolvedValue(errorResult("PERMISSION_DENIED"));
    const onChanged = vi.fn();
    const { container } = await render(<BuiltinRulesTable rules={rules} onChanged={onChanged} />);

    await click(switchOf(container, "Email address"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Permission denied");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(switchOf(container, "Email address").disabled).toBe(false);
  });
});
