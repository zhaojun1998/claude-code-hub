import { DEFAULT_PLACEHOLDER_TEMPLATE } from "./engine";
import { JEV_DEFAULT_BASE_URLS, JEV_DEFAULT_MODELS } from "./jev-client";
import type { JevSettings, RedactionSettings } from "./types";

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  enabled: false,
  provider: "typesafe",
  baseUrl: JEV_DEFAULT_BASE_URLS.typesafe,
  apiKey: "",
  model: JEV_DEFAULT_MODELS.typesafe,
  mode: "sync",
  timeoutMs: 3000,
  autoEnableThreshold: 0.9,
  suggestThreshold: 0.6,
  sendMode: "masked",
  maxCandidatesPerRequest: 16,
};

export const DEFAULT_REDACTION_SETTINGS: RedactionSettings = {
  enabled: false,
  placeholderTemplate: DEFAULT_PLACEHOLDER_TEMPLATE,
  builtinOverrides: {},
  allowlist: [],
  recordOriginals: true,
  incrementalTtlHours: 72,
  eventRetentionDays: 30,
  jev: DEFAULT_JEV_SETTINGS,
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function num(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function str(raw: unknown, fallback: string, maxLength = 512): string {
  return typeof raw === "string" ? raw.trim().slice(0, maxLength) : fallback;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

export function normalizeJevSettings(raw: unknown): JevSettings {
  const input = asRecord(raw);
  const provider = oneOf(input.provider, ["typesafe", "openrouter"] as const, "typesafe");
  const suggestThreshold = num(input.suggestThreshold, DEFAULT_JEV_SETTINGS.suggestThreshold, 0, 1);
  const autoEnableThreshold = num(
    input.autoEnableThreshold,
    DEFAULT_JEV_SETTINGS.autoEnableThreshold,
    0,
    1
  );
  const baseUrl = str(input.baseUrl, "") || JEV_DEFAULT_BASE_URLS[provider];
  return {
    enabled: bool(input.enabled, DEFAULT_JEV_SETTINGS.enabled),
    provider,
    baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : JEV_DEFAULT_BASE_URLS[provider],
    apiKey: str(input.apiKey, "", 1024),
    model: str(input.model, "", 255) || JEV_DEFAULT_MODELS[provider],
    mode: oneOf(input.mode, ["sync", "async"] as const, DEFAULT_JEV_SETTINGS.mode),
    timeoutMs: Math.round(num(input.timeoutMs, DEFAULT_JEV_SETTINGS.timeoutMs, 500, 60_000)),
    autoEnableThreshold: Math.max(autoEnableThreshold, suggestThreshold),
    suggestThreshold,
    sendMode: oneOf(input.sendMode, ["masked", "full"] as const, DEFAULT_JEV_SETTINGS.sendMode),
    maxCandidatesPerRequest: Math.round(
      num(input.maxCandidatesPerRequest, DEFAULT_JEV_SETTINGS.maxCandidatesPerRequest, 1, 64)
    ),
  };
}

export function normalizeRedactionSettings(raw: unknown): RedactionSettings {
  const input = asRecord(raw);
  const template = str(input.placeholderTemplate, DEFAULT_PLACEHOLDER_TEMPLATE, 128);
  const overrides: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(asRecord(input.builtinOverrides))) {
    if (id.startsWith("builtin:") && typeof enabled === "boolean") overrides[id] = enabled;
  }
  const allowlist = Array.isArray(input.allowlist)
    ? [
        ...new Set(
          input.allowlist
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0 && entry.length <= 512)
        ),
      ].slice(0, 500)
    : [];
  return {
    enabled: bool(input.enabled, DEFAULT_REDACTION_SETTINGS.enabled),
    placeholderTemplate: template.includes("{hash}") ? template : DEFAULT_PLACEHOLDER_TEMPLATE,
    builtinOverrides: overrides,
    allowlist,
    recordOriginals: bool(input.recordOriginals, DEFAULT_REDACTION_SETTINGS.recordOriginals),
    incrementalTtlHours: Math.round(
      num(input.incrementalTtlHours, DEFAULT_REDACTION_SETTINGS.incrementalTtlHours, 1, 24 * 30)
    ),
    eventRetentionDays: Math.round(
      num(input.eventRetentionDays, DEFAULT_REDACTION_SETTINGS.eventRetentionDays, 1, 3650)
    ),
    jev: normalizeJevSettings(input.jev),
  };
}

/** Settings as sent to the browser: the Jev API key is replaced by a flag. */
export type PublicRedactionSettings = Omit<RedactionSettings, "jev"> & {
  jev: Omit<JevSettings, "apiKey"> & { hasApiKey: boolean; apiKeyPreview: string };
};

export function toPublicSettings(settings: RedactionSettings): PublicRedactionSettings {
  const { apiKey, ...jev } = settings.jev;
  return {
    ...settings,
    jev: {
      ...jev,
      hasApiKey: apiKey.length > 0,
      apiKeyPreview:
        apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : apiKey ? "***" : "",
    },
  };
}

/**
 * Merges a settings update from the browser. An empty or missing `jev.apiKey` keeps the
 * stored key; `jev.clearApiKey: true` removes it.
 */
export function mergeSettingsUpdate(
  current: RedactionSettings,
  update: unknown
): RedactionSettings {
  const input = asRecord(update);
  const jevInput = asRecord(input.jev);
  const apiKeyInput = typeof jevInput.apiKey === "string" ? jevInput.apiKey.trim() : "";
  const apiKey = jevInput.clearApiKey === true ? "" : apiKeyInput || current.jev.apiKey;
  return normalizeRedactionSettings({
    ...current,
    ...input,
    jev: { ...current.jev, ...jevInput, apiKey },
  });
}
