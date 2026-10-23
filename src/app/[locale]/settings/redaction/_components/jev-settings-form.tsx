"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { redactionApi } from "@/lib/redaction/client-api";
import type { PublicRedactionSettings } from "@/lib/redaction/config";
import type { JevMode, JevProvider, JevSendMode } from "@/lib/redaction/types";
import { useRedactionError } from "./use-redaction-error";

const DEFAULT_BASE_URLS: Record<JevProvider, string> = {
  typesafe: "https://api.typesafe.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

const DEFAULT_MODELS: Record<JevProvider, string> = {
  typesafe: "jev-latest",
  openrouter: "~typesafe/jev-latest",
};

interface JevSettingsFormProps {
  settings: PublicRedactionSettings;
  verdicts: { sensitive: number; benign: number };
  onSaved: () => Promise<void> | void;
}

export function JevSettingsForm({ settings, verdicts, onSaved }: JevSettingsFormProps) {
  const t = useTranslations("settings.redaction");
  const describeError = useRedactionError();
  const jev = settings.jev;
  const [enabled, setEnabled] = useState(jev.enabled);
  const [provider, setProvider] = useState<JevProvider>(jev.provider);
  const [baseUrl, setBaseUrl] = useState(jev.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(jev.model);
  const [mode, setMode] = useState<JevMode>(jev.mode);
  const [timeoutMs, setTimeoutMs] = useState(String(jev.timeoutMs));
  const [autoEnable, setAutoEnable] = useState(String(jev.autoEnableThreshold));
  const [suggest, setSuggest] = useState(String(jev.suggestThreshold));
  const [sendMode, setSendMode] = useState<JevSendMode>(jev.sendMode);
  const [maxCandidates, setMaxCandidates] = useState(String(jev.maxCandidatesPerRequest));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const changeProvider = (next: JevProvider) => {
    setProvider(next);
    setBaseUrl(DEFAULT_BASE_URLS[next]);
    setModel(DEFAULT_MODELS[next]);
  };

  const save = async (extra: Record<string, unknown> = {}) => {
    setSaving(true);
    try {
      const result = await redactionApi.saveSettings({
        jev: {
          enabled,
          provider,
          baseUrl,
          apiKey,
          model,
          mode,
          timeoutMs: Number(timeoutMs),
          autoEnableThreshold: Number(autoEnable),
          suggestThreshold: Number(suggest),
          sendMode,
          maxCandidatesPerRequest: Number(maxCandidates),
          ...extra,
        },
      });
      if (result.ok) {
        setApiKey("");
        toast.success(t("general.saved"));
        await onSaved();
      } else {
        toast.error(describeError(result));
      }
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await redactionApi.testJev();
      if (!result.ok) {
        toast.error(describeError(result));
      } else if (result.data.ok) {
        toast.success(
          t("jev.testOk", {
            ms: result.data.durationMs,
            category: result.data.category ?? "-",
            confidence: (result.data.confidence ?? 0).toFixed(2),
          })
        );
      } else {
        toast.error(t("jev.testFailed", { error: result.data.error ?? "unknown" }));
      }
    } finally {
      setTesting(false);
    }
  };

  const clearVerdicts = async () => {
    const result = await redactionApi.clearJevVerdicts();
    if (result.ok) {
      toast.success(t("jev.clearVerdictsDone", { count: result.data.cleared }));
      await onSaved();
    } else {
      toast.error(describeError(result));
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("jev.description")}</p>
        <p className="text-xs text-muted-foreground">{t("jev.privacyNote")}</p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <Label htmlFor="jev-enabled">{t("jev.enabled")}</Label>
        <Switch id="jev-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>{t("jev.provider")}</Label>
          <Select value={provider} onValueChange={(next) => changeProvider(next as JevProvider)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="typesafe">{t("jev.providerTypesafe")}</SelectItem>
              <SelectItem value="openrouter">{t("jev.providerOpenrouter")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-base-url">{t("jev.baseUrl")}</Label>
          <Input
            id="jev-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-api-key">{t("jev.apiKey")}</Label>
          <Input
            id="jev-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              jev.hasApiKey
                ? t("jev.apiKeyKeep", { preview: jev.apiKeyPreview })
                : t("jev.apiKeyMissing")
            }
          />
          {jev.hasApiKey && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => save({ clearApiKey: true })}
            >
              {t("jev.apiKeyClear")}
            </Button>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-model">{t("jev.model")}</Label>
          <Input id="jev-model" value={model} onChange={(event) => setModel(event.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>{t("jev.mode")}</Label>
          <Select value={mode} onValueChange={(next) => setMode(next as JevMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sync">{t("jev.modeSync")}</SelectItem>
              <SelectItem value="async">{t("jev.modeAsync")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>{t("jev.sendMode")}</Label>
          <Select value={sendMode} onValueChange={(next) => setSendMode(next as JevSendMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="masked">{t("jev.sendModeMasked")}</SelectItem>
              <SelectItem value="full">{t("jev.sendModeFull")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-auto">{t("jev.autoEnableThreshold")}</Label>
          <Input
            id="jev-auto"
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={autoEnable}
            onChange={(event) => setAutoEnable(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("jev.autoEnableThresholdHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-suggest">{t("jev.suggestThreshold")}</Label>
          <Input
            id="jev-suggest"
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={suggest}
            onChange={(event) => setSuggest(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("jev.suggestThresholdHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-timeout">{t("jev.timeoutMs")}</Label>
          <Input
            id="jev-timeout"
            type="number"
            min={500}
            max={60000}
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="jev-max">{t("jev.maxCandidates")}</Label>
          <Input
            id="jev-max"
            type="number"
            min={1}
            max={64}
            value={maxCandidates}
            onChange={(event) => setMaxCandidates(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save()} disabled={saving}>
          {saving ? t("general.saving") : t("general.save")}
        </Button>
        <Button variant="outline" onClick={test} disabled={testing || !jev.hasApiKey}>
          {testing ? t("jev.testing") : t("jev.test")}
        </Button>
        <Button variant="outline" onClick={clearVerdicts}>
          {t("jev.clearVerdicts")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("jev.verdicts", { sensitive: verdicts.sensitive, benign: verdicts.benign })}
        </span>
      </div>
    </div>
  );
}
