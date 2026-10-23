"use client";

import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionEventRecord } from "@/lib/redaction/types";
import { useRedactionRuleName } from "./use-rule-name";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; events: RedactionEventRecord[] };

/** Lists the values newly masked in one request: original, placeholder, location, context. */
export function RedactionFindings({ requestId }: { requestId: number }) {
  const t = useTranslations("settings.redaction");
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    redactionApi
      .getEvents(requestId)
      .then((result) => {
        if (cancelled) return;
        setState(result.ok ? { status: "ready", events: result.data } : { status: "error" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (state.status === "loading") {
    return <p className="text-xs text-muted-foreground">{t("logs.loading")}</p>;
  }
  if (state.status === "error") {
    return <p className="text-xs text-destructive">{t("logs.loadFailed")}</p>;
  }
  return <RedactionFindingsList events={state.events} />;
}

/** Renders the findings of already loaded redaction records (also used by the records page). */
export function RedactionFindingsList({ events }: { events: RedactionEventRecord[] }) {
  const t = useTranslations("settings.redaction");
  const ruleName = useRedactionRuleName();

  const findings = events.flatMap((event) => event.findings);
  const newCount = events.reduce((sum, event) => sum + event.newCount, 0);
  const total = events.reduce((max, event) => Math.max(max, event.totalCount), 0);
  const originalsMasked = events.some((event) => !event.originalsRecorded);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("logs.copied"));
    } catch {
      // Clipboard access can be denied; nothing else to do.
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("logs.summary", { count: newCount, total })}
      </p>
      {originalsMasked && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t("logs.maskedOriginal")}</p>
      )}
      <ul className="space-y-2">
        {findings.map((finding, index) => (
          <li key={`${finding.path}-${index}`} className="space-y-1.5 rounded-md border p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{t(`category.${finding.category}`)}</Badge>
              <span className="text-xs font-medium">
                {ruleName(finding.ruleId, finding.ruleName)}
              </span>
            </div>
            <div className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-1 text-xs">
              <span className="text-muted-foreground">{t("logs.original")}</span>
              <div className="flex items-start gap-1">
                <code className="break-all rounded bg-red-500/10 px-1 text-red-700 dark:text-red-300">
                  {finding.original}
                </code>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5 shrink-0"
                  aria-label={t("logs.copy")}
                  title={t("logs.copy")}
                  onClick={() => copy(finding.original)}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <span className="text-muted-foreground">{t("logs.redacted")}</span>
              <code className="break-all rounded bg-emerald-500/10 px-1 text-emerald-700 dark:text-emerald-300">
                {finding.replacement}
              </code>
              <span className="text-muted-foreground">{t("logs.location")}</span>
              <code className="break-all text-muted-foreground">{finding.path}</code>
              {(finding.contextBefore || finding.contextAfter) && (
                <>
                  <span className="text-muted-foreground">{t("logs.context")}</span>
                  <code className="whitespace-pre-wrap break-all text-muted-foreground">
                    {finding.contextBefore}
                    <span className="font-semibold text-foreground">{finding.replacement}</span>
                    {finding.contextAfter}
                  </code>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {newCount > findings.length && (
        <p className="text-xs text-muted-foreground">
          {t("logs.more", { count: newCount - findings.length })}
        </p>
      )}
    </div>
  );
}
