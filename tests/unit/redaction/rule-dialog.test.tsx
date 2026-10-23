/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuleDialog } from "@/app/[locale]/settings/redaction/_components/rule-dialog";
import { redactionApi } from "@/lib/redaction/client-api";
import {
  changeValue,
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  getButton,
  getSelectWithOption,
  makeStoredRule,
  okResult,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { createRule: vi.fn(), updateRule: vi.fn() },
}));

vi.mock("@/components/ui/dialog", async () => (await import("./ui-helpers")).dialogStub);
vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub);

const createRule = vi.mocked(redactionApi.createRule);
const updateRule = vi.mocked(redactionApi.updateRule);

function input(container: HTMLElement, id: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

beforeEach(() => {
  createRule.mockResolvedValue(okResult(makeStoredRule({ id: 7 })));
  updateRule.mockResolvedValue(okResult(makeStoredRule({ id: 3 })));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("RuleDialog", () => {
  test("renders nothing while closed", async () => {
    const { container } = await render(
      <RuleDialog open={false} onOpenChange={vi.fn()} rule={null} onSaved={vi.fn()} />
    );

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("starts with an empty regex form in add mode", async () => {
    const { container } = await render(
      <RuleDialog open onOpenChange={vi.fn()} rule={null} onSaved={vi.fn()} />
    );

    expect(textOf(container.querySelector("h2"))).toBe("Add Rule");
    expect(container.textContent).toContain(
      "Matches are replaced with a placeholder built from the label."
    );
    expect(input(container, "rule-name").value).toBe("");
    expect(input(container, "rule-name").getAttribute("placeholder")).toBe(
      "e.g. Internal API token"
    );
    expect(input(container, "rule-label").value).toBe("SECRET");
    expect(input(container, "rule-pattern").value).toBe("");
    expect(input(container, "rule-flags").value).toBe("");
    expect(input(container, "rule-group").value).toBe("0");
    expect(input(container, "rule-description").value).toBe("");
    expect(getSelectWithOption(container, "pii").value).toBe("secret");
    expect(getSelectWithOption(container, "literal").value).toBe("regex");
    const categoryLabels = Array.from(getSelectWithOption(container, "pii").options).map(textOf);
    expect(categoryLabels).toEqual(["Secret", "Personal data", "Network", "Custom"]);
  });

  // Regression: the regex quantifier {32} must not be parsed as an ICU argument.
  test("shows the regex pattern example as the pattern placeholder", async () => {
    const { container } = await render(
      <RuleDialog open onOpenChange={vi.fn()} rule={null} onSaved={vi.fn()} />
    );

    expect(input(container, "rule-pattern").getAttribute("placeholder")).toBe(
      "e.g. acme_[A-Za-z0-9]{32}"
    );
  });

  test("creates a rule from the filled form", async () => {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const { container } = await render(
      <RuleDialog open onOpenChange={onOpenChange} rule={null} onSaved={onSaved} />
    );

    await changeValue(input(container, "rule-name"), "ACME token");
    await changeValue(getSelectWithOption(container, "pii"), "custom");
    await changeValue(input(container, "rule-label"), "acme_token");
    await changeValue(input(container, "rule-pattern"), "acme_([A-Za-z0-9]{32})");
    await changeValue(input(container, "rule-flags"), "i");
    await changeValue(input(container, "rule-group"), "1");
    await changeValue(input(container, "rule-description"), "Tokens of the ACME API");

    // Labels are upper-cased while typing.
    expect(input(container, "rule-label").value).toBe("ACME_TOKEN");

    await click(getButton(container, "Save"));
    await flush();

    expect(createRule).toHaveBeenCalledWith({
      name: "ACME token",
      category: "custom",
      label: "ACME_TOKEN",
      kind: "regex",
      pattern: "acme_([A-Za-z0-9]{32})",
      flags: "i",
      groupIndex: 1,
      description: "Tokens of the ACME API",
    });
    expect(updateRule).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Rule created");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("hides regex-only fields for exact-value rules", async () => {
    const { container } = await render(
      <RuleDialog open onOpenChange={vi.fn()} rule={null} onSaved={vi.fn()} />
    );

    await changeValue(getSelectWithOption(container, "literal"), "literal");

    expect(container.querySelector("#rule-flags")).toBeNull();
    expect(container.querySelector("#rule-group")).toBeNull();
    expect(input(container, "rule-pattern").getAttribute("placeholder")).toBe(
      "The exact value to hide"
    );

    await changeValue(input(container, "rule-name"), "Customer name");
    await changeValue(input(container, "rule-pattern"), "Globex Corporation");
    await click(getButton(container, "Save"));
    await flush();

    expect(createRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Customer name",
        kind: "literal",
        pattern: "Globex Corporation",
      })
    );
  });

  test("prefills the form in edit mode and updates the rule with its status", async () => {
    const rule = makeStoredRule({
      id: 3,
      name: "Discovered token",
      category: "network",
      label: "HOST",
      kind: "regex",
      pattern: "db\\d+\\.corp",
      flags: "i",
      groupIndex: 0,
      description: "Found by Jev",
      source: "jev",
      status: "pending",
      confidence: 0.72,
    });
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const { container } = await render(
      <RuleDialog open onOpenChange={onOpenChange} rule={rule} onSaved={onSaved} />
    );

    expect(textOf(container.querySelector("h2"))).toBe("Edit Rule");
    expect(input(container, "rule-name").value).toBe("Discovered token");
    expect(input(container, "rule-label").value).toBe("HOST");
    expect(input(container, "rule-pattern").value).toBe("db\\d+\\.corp");
    expect(input(container, "rule-flags").value).toBe("i");
    expect(input(container, "rule-description").value).toBe("Found by Jev");
    expect(getSelectWithOption(container, "pii").value).toBe("network");

    await changeValue(input(container, "rule-name"), "Corp database host");
    await click(getButton(container, "Save"));
    await flush();

    expect(updateRule).toHaveBeenCalledWith(3, {
      name: "Corp database host",
      category: "network",
      label: "HOST",
      kind: "regex",
      pattern: "db\\d+\\.corp",
      flags: "i",
      groupIndex: 0,
      description: "Found by Jev",
      status: "pending",
    });
    expect(createRule).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Rule updated");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("maps null optional fields of a stored rule to form defaults", async () => {
    const rule = makeStoredRule({
      id: 4,
      kind: "literal",
      pattern: "Globex Corporation",
      flags: null,
      groupIndex: null,
      description: null,
      status: "active",
    });
    const { container } = await render(
      <RuleDialog open onOpenChange={vi.fn()} rule={rule} onSaved={vi.fn()} />
    );

    expect(input(container, "rule-description").value).toBe("");

    await click(getButton(container, "Save"));
    await flush();

    expect(updateRule).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ flags: "", groupIndex: 0, description: "", status: "active" })
    );
  });

  test("keeps the dialog open and shows the translated error when saving fails", async () => {
    createRule.mockResolvedValue(errorResult("INVALID_REGEX"));
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const { container } = await render(
      <RuleDialog open onOpenChange={onOpenChange} rule={null} onSaved={onSaved} />
    );

    await click(getButton(container, "Save"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Invalid regular expression");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(getButton(container, "Save").disabled).toBe(false);
  });

  test("disables Save while the request is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.createRule>>>();
    createRule.mockReturnValue(pending.promise);
    const { container } = await render(
      <RuleDialog open onOpenChange={vi.fn()} rule={null} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Save"));
    expect(getButton(container, "Save").disabled).toBe(true);

    pending.resolve(okResult(makeStoredRule()));
    await flush();
    expect(getButton(container, "Save").disabled).toBe(false);
  });

  test("Cancel closes the dialog without saving", async () => {
    const onOpenChange = vi.fn();
    const { container } = await render(
      <RuleDialog open onOpenChange={onOpenChange} rule={null} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Cancel"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createRule).not.toHaveBeenCalled();
  });

  test("resets the form when it is reopened", async () => {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const rule = makeStoredRule({ id: 9, name: "Old name" });
    const { container, rerender } = await render(
      <RuleDialog open onOpenChange={onOpenChange} rule={rule} onSaved={onSaved} />
    );
    await changeValue(input(container, "rule-name"), "Unsaved edit");

    await rerender(
      <RuleDialog open={false} onOpenChange={onOpenChange} rule={rule} onSaved={onSaved} />
    );
    await rerender(<RuleDialog open onOpenChange={onOpenChange} rule={null} onSaved={onSaved} />);

    expect(textOf(container.querySelector("h2"))).toBe("Add Rule");
    expect(input(container, "rule-name").value).toBe("");
    expect(input(container, "rule-label").value).toBe("SECRET");
  });
});
