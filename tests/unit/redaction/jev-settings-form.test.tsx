/**
 * @vitest-environment happy-dom
 */

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JevSettingsForm } from "@/app/[locale]/settings/redaction/_components/jev-settings-form";
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
  makeSettings,
  okResult,
  queryButtons,
  render,
  textOf,
} from "./ui-helpers";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: { saveSettings: vi.fn(), testJev: vi.fn(), clearJevVerdicts: vi.fn() },
}));

vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub);

const api = vi.mocked(redactionApi);

const verdicts = { sensitive: 3, benign: 5 };

function settingsWithKey() {
  return makeSettings({
    jev: {
      enabled: false,
      provider: "typesafe",
      apiKey: "sk-jev-1234567890abcd",
      mode: "sync",
      timeoutMs: 3000,
      autoEnableThreshold: 0.9,
      suggestThreshold: 0.6,
      sendMode: "masked",
      maxCandidatesPerRequest: 16,
    },
  });
}

function settingsWithoutKey() {
  return makeSettings({ jev: { enabled: true, provider: "openrouter" } });
}

function field(container: HTMLElement, id: string) {
  const element = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

const defaultPayload = {
  enabled: false,
  provider: "typesafe",
  baseUrl: "https://api.typesafe.ai/v1",
  apiKey: "",
  model: "jev-latest",
  mode: "sync",
  timeoutMs: 3000,
  autoEnableThreshold: 0.9,
  suggestThreshold: 0.6,
  sendMode: "masked",
  maxCandidatesPerRequest: 16,
};

beforeEach(() => {
  api.saveSettings.mockResolvedValue(okResult(settingsWithKey()));
  api.testJev.mockResolvedValue(
    okResult({
      ok: true,
      durationMs: 120,
      model: "jev-latest",
      category: "secret",
      confidence: 0.934,
    })
  );
  api.clearJevVerdicts.mockResolvedValue(okResult({ cleared: 4 }));
});

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("JevSettingsForm", () => {
  test("shows the stored Jev settings, the saved key hint and the verdict counts", async () => {
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    expect(container.textContent).toContain("Enable Jev discovery");
    expect(field(container, "jev-enabled").getAttribute("aria-checked")).toBe("false");
    expect(getSelectWithOption(container, "openrouter").value).toBe("typesafe");
    expect(getSelectWithOption(container, "async").value).toBe("sync");
    expect(getSelectWithOption(container, "full").value).toBe("masked");
    expect(field(container, "jev-base-url").value).toBe("https://api.typesafe.ai/v1");
    expect(field(container, "jev-model").value).toBe("jev-latest");
    expect(field(container, "jev-api-key").value).toBe("");
    expect(field(container, "jev-api-key").getAttribute("placeholder")).toBe(
      "Leave empty to keep the saved key (sk-j…abcd)"
    );
    expect(field(container, "jev-auto").value).toBe("0.9");
    expect(field(container, "jev-suggest").value).toBe("0.6");
    expect(field(container, "jev-timeout").value).toBe("3000");
    expect(field(container, "jev-max").value).toBe("16");
    expect(queryButtons(container, "Clear saved key")).toHaveLength(1);
    expect(getButton(container, "Test Connection").disabled).toBe(false);
    expect(container.textContent).toContain("Judged values: 3 sensitive, 5 benign");

    const providerLabels = Array.from(getSelectWithOption(container, "openrouter").options).map(
      textOf
    );
    expect(providerLabels).toEqual(["TypeSafe (direct)", "OpenRouter"]);
  });

  test("without a saved key it hides the clear link and disables the connection test", async () => {
    const { container } = await render(
      <JevSettingsForm settings={settingsWithoutKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    expect(field(container, "jev-api-key").getAttribute("placeholder")).toBe("No key saved");
    expect(queryButtons(container, "Clear saved key")).toHaveLength(0);
    expect(getButton(container, "Test Connection").disabled).toBe(true);
    expect(field(container, "jev-enabled").getAttribute("aria-checked")).toBe("true");
    expect(field(container, "jev-base-url").value).toBe("https://openrouter.ai/api/v1");
  });

  test("switching the provider resets base URL and model to that provider's defaults", async () => {
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await changeValue(field(container, "jev-model"), "custom-model");
    await changeValue(getSelectWithOption(container, "openrouter"), "openrouter");

    expect(getSelectWithOption(container, "openrouter").value).toBe("openrouter");
    expect(field(container, "jev-base-url").value).toBe("https://openrouter.ai/api/v1");
    expect(field(container, "jev-model").value).toBe("~typesafe/jev-latest");

    await changeValue(getSelectWithOption(container, "typesafe"), "typesafe");

    expect(field(container, "jev-base-url").value).toBe("https://api.typesafe.ai/v1");
    expect(field(container, "jev-model").value).toBe("jev-latest");
  });

  test("saves every field, sends a newly typed key and clears the input afterwards", async () => {
    const onSaved = vi.fn();
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={onSaved} />
    );

    await click(field(container, "jev-enabled"));
    await changeValue(getSelectWithOption(container, "openrouter"), "openrouter");
    await changeValue(field(container, "jev-base-url"), "https://proxy.example.com/api/v1");
    await changeValue(field(container, "jev-api-key"), "or-new-key");
    await changeValue(field(container, "jev-model"), "typesafe/jev-small");
    await changeValue(getSelectWithOption(container, "async"), "async");
    await changeValue(getSelectWithOption(container, "full"), "full");
    await changeValue(field(container, "jev-auto"), "0.95");
    await changeValue(field(container, "jev-suggest"), "0.5");
    await changeValue(field(container, "jev-timeout"), "5000");
    await changeValue(field(container, "jev-max"), "8");

    await click(getButton(container, "Save"));
    await flush();

    expect(api.saveSettings).toHaveBeenCalledWith({
      jev: {
        enabled: true,
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/api/v1",
        apiKey: "or-new-key",
        model: "typesafe/jev-small",
        mode: "async",
        timeoutMs: 5000,
        autoEnableThreshold: 0.95,
        suggestThreshold: 0.5,
        sendMode: "full",
        maxCandidatesPerRequest: 8,
      },
    });
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(field(container, "jev-api-key").value).toBe("");
  });

  test("an empty key field keeps the saved key", async () => {
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Save"));
    await flush();

    expect(api.saveSettings).toHaveBeenCalledWith({ jev: defaultPayload });
    const [[payload]] = api.saveSettings.mock.calls;
    expect(payload.jev).not.toHaveProperty("clearApiKey");
  });

  test("Clear saved key sends clearApiKey", async () => {
    const onSaved = vi.fn();
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={onSaved} />
    );

    await click(getButton(container, "Clear saved key"));
    await flush();

    expect(api.saveSettings).toHaveBeenCalledWith({
      jev: { ...defaultPayload, clearApiKey: true },
    });
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("a failed save keeps the typed key and shows the translated error", async () => {
    api.saveSettings.mockResolvedValue(errorResult("PERMISSION_DENIED"));
    const onSaved = vi.fn();
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={onSaved} />
    );

    await changeValue(field(container, "jev-api-key"), "typed-key");
    await click(getButton(container, "Save"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Permission denied");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(field(container, "jev-api-key").value).toBe("typed-key");
    expect(getButton(container, "Save").disabled).toBe(false);
  });

  test("shows the saving label while a save is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.saveSettings>>>();
    api.saveSettings.mockReturnValue(pending.promise);
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Save"));
    expect(getButton(container, "Saving...").disabled).toBe(true);

    pending.resolve(okResult(settingsWithKey()));
    await flush();
    expect(getButton(container, "Save").disabled).toBe(false);
  });

  test("a successful connection test reports latency, category and confidence", async () => {
    const pending = deferred<Awaited<ReturnType<typeof redactionApi.testJev>>>();
    api.testJev.mockReturnValue(pending.promise);
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Test Connection"));
    expect(getButton(container, "Testing...").disabled).toBe(true);

    pending.resolve(
      okResult({
        ok: true,
        durationMs: 120,
        model: "jev-latest",
        category: "secret",
        confidence: 0.934,
      })
    );
    await flush();

    expect(api.testJev).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Jev answered in 120 ms: secret (0.93)");
    expect(getButton(container, "Test Connection").disabled).toBe(false);
  });

  test("a successful test without category or confidence uses placeholders", async () => {
    api.testJev.mockResolvedValue(okResult({ ok: true, durationMs: 45 }));
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Test Connection"));
    await flush();

    expect(toast.success).toHaveBeenCalledWith("Jev answered in 45 ms: - (0.00)");
  });

  test("a failed Jev answer shows its error, or 'unknown' when none is given", async () => {
    api.testJev
      .mockResolvedValueOnce(
        okResult({ ok: false, durationMs: 3000, error: "timeout after 3000 ms" })
      )
      .mockResolvedValueOnce(okResult({ ok: false, durationMs: 10 }));
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Test Connection"));
    await flush();
    await click(getButton(container, "Test Connection"));
    await flush();

    expect(toast.error).toHaveBeenNthCalledWith(1, "Jev test failed: timeout after 3000 ms");
    expect(toast.error).toHaveBeenNthCalledWith(2, "Jev test failed: unknown");
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("a failed test request shows the translated error code", async () => {
    api.testJev.mockResolvedValue(errorResult("JEV_TEST_FAILED"));
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={vi.fn()} />
    );

    await click(getButton(container, "Test Connection"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Jev test failed");
  });

  test("Forget Verdicts clears them, reports the count and refreshes", async () => {
    const onSaved = vi.fn();
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={onSaved} />
    );

    await click(getButton(container, "Forget Verdicts"));
    await flush();

    expect(api.clearJevVerdicts).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Cleared 4 verdicts");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("a failed verdict reset shows the error and does not refresh", async () => {
    api.clearJevVerdicts.mockResolvedValue(errorResult("SAVE_FAILED"));
    const onSaved = vi.fn();
    const { container } = await render(
      <JevSettingsForm settings={settingsWithKey()} verdicts={verdicts} onSaved={onSaved} />
    );

    await click(getButton(container, "Forget Verdicts"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Failed to save");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
