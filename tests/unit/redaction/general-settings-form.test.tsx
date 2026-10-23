/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GeneralSettingsForm } from "@/app/[locale]/settings/redaction/_components/general-settings-form";
import { redactionApi } from "@/lib/redaction/client-api";
import {
  changeValue,
  cleanup,
  click,
  deferred,
  errorResult,
  flush,
  getButton,
  makeSettings,
  okResult,
  render,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { saveSettings: vi.fn() },
}));

const saveSettings = vi.mocked(redactionApi.saveSettings);

function settings() {
  return makeSettings({
    enabled: false,
    recordOriginals: true,
    placeholderTemplate: "<{label}:{hash}>",
    incrementalTtlHours: 48,
    eventRetentionDays: 14,
    allowlist: ["example.com", "localhost"],
  });
}

function field(container: HTMLElement, id: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

beforeEach(() => {
  saveSettings.mockResolvedValue(okResult(settings()));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("GeneralSettingsForm", () => {
  test("shows the stored settings", async () => {
    const { container } = await render(
      <GeneralSettingsForm settings={settings()} onSaved={vi.fn()} />
    );

    expect(container.textContent).toContain("Enable redaction");
    expect(container.textContent).toContain("Store original values in usage logs");
    expect(field(container, "redaction-template").value).toBe("<{label}:{hash}>");
    expect(field(container, "redaction-ttl").value).toBe("48");
    expect(field(container, "redaction-retention").value).toBe("14");
    expect(field(container, "redaction-allowlist").value).toBe("example.com\nlocalhost");
    expect(field(container, "redaction-enabled").getAttribute("aria-checked")).toBe("false");
    expect(field(container, "redaction-record-originals").getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(getButton(container, "Save").disabled).toBe(false);
  });

  // Regression: the hint's {label}/{hash} tokens are ICU arguments and must be passed through.
  test("shows the placeholder template hint with its literal tokens", async () => {
    const { container } = await render(
      <GeneralSettingsForm settings={settings()} onSaved={vi.fn()} />
    );

    expect(container.textContent).toContain(
      "{label} and {hash} are substituted. {hash} is required."
    );
  });

  test("saves the edited values, toasts and calls onSaved", async () => {
    const onSaved = vi.fn();
    const { container } = await render(
      <GeneralSettingsForm settings={settings()} onSaved={onSaved} />
    );

    await click(field(container, "redaction-enabled"));
    await click(field(container, "redaction-record-originals"));
    await changeValue(field(container, "redaction-template"), "[{label}#{hash}]");
    await changeValue(field(container, "redaction-ttl"), "24");
    await changeValue(field(container, "redaction-retention"), "90");
    await changeValue(field(container, "redaction-allowlist"), " foo \n\nbar.internal\n");

    expect(field(container, "redaction-enabled").getAttribute("aria-checked")).toBe("true");
    expect(field(container, "redaction-record-originals").getAttribute("aria-checked")).toBe(
      "false"
    );

    await click(getButton(container, "Save"));
    await flush();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      enabled: true,
      recordOriginals: false,
      placeholderTemplate: "[{label}#{hash}]",
      incrementalTtlHours: 24,
      eventRetentionDays: 90,
      allowlist: ["foo", "bar.internal"],
    });
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
    expect(toast.error).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("disables the button and shows the saving label while the request is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.saveSettings>>>();
    saveSettings.mockReturnValue(pending.promise);
    const { container } = await render(
      <GeneralSettingsForm settings={settings()} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Save"));

    const busy = getButton(container, "Saving...");
    expect(busy.disabled).toBe(true);

    pending.resolve(okResult(settings()));
    await flush();

    expect(getButton(container, "Save").disabled).toBe(false);
  });

  test("maps a known error code to its translated message", async () => {
    saveSettings.mockResolvedValue(errorResult("SAVE_FAILED"));
    const onSaved = vi.fn();
    const { container } = await render(
      <GeneralSettingsForm settings={settings()} onSaved={onSaved} />
    );

    await click(getButton(container, "Save"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Failed to save");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(getButton(container, "Save").disabled).toBe(false);
  });

  test("falls back to the UNKNOWN message for unrecognized or missing error codes", async () => {
    saveSettings
      .mockResolvedValueOnce(errorResult("SOMETHING_ELSE"))
      .mockResolvedValueOnce(errorResult(undefined));
    const { container } = await render(
      <GeneralSettingsForm settings={settings()} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Save"));
    await flush();
    await click(getButton(container, "Save"));
    await flush();

    expect(toast.error).toHaveBeenNthCalledWith(1, "Operation failed");
    expect(toast.error).toHaveBeenNthCalledWith(2, "Operation failed");
  });
});
