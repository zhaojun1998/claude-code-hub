"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { UsageLogFilters } from "../filters/types";

interface RedactedOnlyFilterProps {
  filters: UsageLogFilters;
  onFiltersChange: (filters: UsageLogFilters) => void;
}

/** Usage log filter: only requests that recorded at least one redaction (fork feature). */
export function RedactedOnlyFilter({ filters, onFiltersChange }: RedactedOnlyFilterProps) {
  const t = useTranslations("settings.redaction.logs");
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2">
      <Label htmlFor="redacted-only-filter" className="text-sm font-normal">
        {t("filterRedactedOnly")}
      </Label>
      <Switch
        id="redacted-only-filter"
        checked={Boolean(filters.redactedOnly)}
        onCheckedChange={(checked) =>
          onFiltersChange({ ...filters, redactedOnly: checked ? true : undefined })
        }
        aria-label={t("filterRedactedOnly")}
      />
    </div>
  );
}
