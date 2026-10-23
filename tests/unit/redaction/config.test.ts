import { describe, expect, test } from "vitest";
import {
  DEFAULT_REDACTION_SETTINGS,
  mergeSettingsUpdate,
  normalizeJevSettings,
  normalizeRedactionSettings,
  toPublicSettings,
} from "@/lib/redaction/config";

describe("redaction settings", () => {
  test("defaults for missing or malformed input", () => {
    expect(normalizeRedactionSettings(undefined)).toEqual(DEFAULT_REDACTION_SETTINGS);
    expect(normalizeRedactionSettings("nope")).toEqual(DEFAULT_REDACTION_SETTINGS);
    expect(normalizeRedactionSettings([1])).toEqual(DEFAULT_REDACTION_SETTINGS);
  });

  test("clamps numbers and filters lists", () => {
    const settings = normalizeRedactionSettings({
      enabled: true,
      placeholderTemplate: "<{label}>",
      builtinOverrides: { "builtin:email": true, "custom:1": true, "builtin:ipv4": "yes" },
      allowlist: [" keep ", "keep", "", 3, "x".repeat(600)],
      incrementalTtlHours: "0",
      eventRetentionDays: 99999,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.placeholderTemplate).toBe(DEFAULT_REDACTION_SETTINGS.placeholderTemplate);
    expect(settings.builtinOverrides).toEqual({ "builtin:email": true });
    expect(settings.allowlist).toEqual(["keep"]);
    expect(settings.incrementalTtlHours).toBe(1);
    expect(settings.eventRetentionDays).toBe(3650);
  });

  test("Jev settings: provider defaults, thresholds, invalid URLs", () => {
    const openrouter = normalizeJevSettings({
      provider: "openrouter",
      baseUrl: "ftp://x",
      model: "",
    });
    expect(openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouter.model).toBe("~typesafe/jev-latest");
    const thresholds = normalizeJevSettings({
      suggestThreshold: 0.8,
      autoEnableThreshold: 0.5,
      mode: "x",
    });
    expect(thresholds.autoEnableThreshold).toBe(0.8);
    expect(thresholds.mode).toBe("sync");
    expect(normalizeJevSettings({ timeoutMs: 10 }).timeoutMs).toBe(500);
    expect(normalizeJevSettings({ provider: "other" }).provider).toBe("typesafe");
  });

  test("API key is kept, replaced or cleared, and never exposed", () => {
    const current = normalizeRedactionSettings({ jev: { apiKey: "secret-key-123456" } });
    expect(mergeSettingsUpdate(current, { jev: { apiKey: "" } }).jev.apiKey).toBe(
      "secret-key-123456"
    );
    expect(mergeSettingsUpdate(current, { jev: { model: "jev-preview" } }).jev.apiKey).toBe(
      "secret-key-123456"
    );
    expect(mergeSettingsUpdate(current, { jev: { apiKey: " new-key " } }).jev.apiKey).toBe(
      "new-key"
    );
    expect(mergeSettingsUpdate(current, { jev: { clearApiKey: true } }).jev.apiKey).toBe("");
    expect(mergeSettingsUpdate(current, { enabled: true }).enabled).toBe(true);

    const exposed = toPublicSettings(current);
    expect(JSON.stringify(exposed)).not.toContain("secret-key-123456");
    expect(exposed.jev.hasApiKey).toBe(true);
    expect(exposed.jev.apiKeyPreview).toBe("secr…3456");
    expect(
      toPublicSettings(normalizeRedactionSettings({ jev: { apiKey: "short" } })).jev.apiKeyPreview
    ).toBe("***");
    expect(toPublicSettings(DEFAULT_REDACTION_SETTINGS).jev.hasApiKey).toBe(false);
  });
});
