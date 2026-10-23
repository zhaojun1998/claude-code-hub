"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { redactionApi } from "@/lib/redaction/client-api";
import type { PublicRedactionSettings } from "@/lib/redaction/config";
import { useRedactionError } from "./use-redaction-error";

interface GeneralSettingsFormProps {
  settings: PublicRedactionSettings;
  onSaved: () => Promise<void> | void;
}

export function GeneralSettingsForm({ settings, onSaved }: GeneralSettingsFormProps) {
  const t = useTranslations("settings.redaction.general");
  const describeError = useRedactionError();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [recordOriginals, setRecordOriginals] = useState(settings.recordOriginals);
  const [template, setTemplate] = useState(settings.placeholderTemplate);
  const [ttlHours, setTtlHours] = useState(String(settings.incrementalTtlHours));
  const [retentionDays, setRetentionDays] = useState(String(settings.eventRetentionDays));
  const [allowlist, setAllowlist] = useState(settings.allowlist.join("\n"));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await redactionApi.saveSettings({
        enabled,
        recordOriginals,
        placeholderTemplate: template,
        incrementalTtlHours: Number(ttlHours),
        eventRetentionDays: Number(retentionDays),
        allowlist: allowlist
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
      });
      if (result.ok) {
        toast.success(t("saved"));
        await onSaved();
      } else {
        toast.error(describeError(result));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("description")}</p>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="redaction-enabled">{t("enabled")}</Label>
          <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
        </div>
        <Switch id="redaction-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="redaction-record-originals">{t("recordOriginals")}</Label>
          <p className="text-xs text-muted-foreground">{t("recordOriginalsHint")}</p>
        </div>
        <Switch
          id="redaction-record-originals"
          checked={recordOriginals}
          onCheckedChange={setRecordOriginals}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="redaction-template">{t("placeholderTemplate")}</Label>
          <Input
            id="redaction-template"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            {t("placeholderTemplateHint", { label: "{label}", hash: "{hash}" })}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="redaction-ttl">{t("incrementalTtlHours")}</Label>
          <Input
            id="redaction-ttl"
            type="number"
            min={1}
            max={720}
            value={ttlHours}
            onChange={(event) => setTtlHours(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("incrementalTtlHoursHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="redaction-retention">{t("eventRetentionDays")}</Label>
          <Input
            id="redaction-retention"
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="redaction-allowlist">{t("allowlist")}</Label>
        <Textarea
          id="redaction-allowlist"
          rows={4}
          value={allowlist}
          onChange={(event) => setAllowlist(event.target.value)}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">{t("allowlistHint")}</p>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? t("saving") : t("save")}
      </Button>
    </div>
  );
}
