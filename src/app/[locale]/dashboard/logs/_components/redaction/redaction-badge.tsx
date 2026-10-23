"use client";

import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RedactionEventSummary } from "@/lib/redaction/types";
import { RedactionFindings } from "./redaction-findings";
import { redactionSummaryLoader } from "./summary-loader";

/** Summary of the redaction record of one request; `null` when nothing was masked. */
export function useRedactionSummary(requestId: number | null | undefined) {
  const [summary, setSummary] = useState<RedactionEventSummary | null>(() =>
    requestId ? (redactionSummaryLoader.peek(requestId) ?? null) : null
  );

  useEffect(() => {
    if (!requestId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    void redactionSummaryLoader.load(requestId).then((next) => {
      if (!cancelled) setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  return summary;
}

/** Small marker shown next to a usage log row whose new content was redacted. */
export function RedactionBadge({ requestId }: { requestId: number | null | undefined }) {
  const t = useTranslations("settings.redaction.logs");
  const summary = useRedactionSummary(requestId);
  if (!requestId || !summary || summary.newCount === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
          title={t("badgeTooltip", { count: summary.newCount, total: summary.totalCount })}
          aria-label={t("badgeTooltip", { count: summary.newCount, total: summary.totalCount })}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {t("badge", { count: summary.newCount })}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-[min(92vw,520px)] overflow-y-auto">
        <h4 className="mb-2 text-sm font-semibold">{t("title")}</h4>
        <RedactionFindings requestId={requestId} />
      </PopoverContent>
    </Popover>
  );
}

/** Section for the request details sheet; renders nothing for requests without redactions. */
export function RedactionDetailsSection({ requestId }: { requestId: number | null | undefined }) {
  const t = useTranslations("settings.redaction.logs");
  const summary = useRedactionSummary(requestId);
  if (!requestId || !summary || summary.newCount === 0) return null;

  return (
    <div className="mb-4 space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        {t("title")}
      </h4>
      <RedactionFindings requestId={requestId} />
    </div>
  );
}
