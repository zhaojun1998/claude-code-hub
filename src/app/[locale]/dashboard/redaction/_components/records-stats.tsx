"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/routing";
import { redactionApi } from "@/lib/redaction/client-api";
import { useRedactionRuleName } from "../../logs/_components/redaction/use-rule-name";
import { RecordsMessage, type RecordsRangeQuery } from "./records-shared";
import { useActionResource } from "./use-action-resource";

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function RecordsStats({ range }: { range: RecordsRangeQuery }) {
  const t = useTranslations("settings.redaction.records");
  const ruleName = useRedactionRuleName();
  const load = useCallback(() => redactionApi.getRecordStats(range), [range]);
  const state = useActionResource(load);

  if (state.status === "loading") return <RecordsMessage>{t("loading")}</RecordsMessage>;
  if (state.status === "error")
    return <RecordsMessage tone="error">{t("loadFailed")}</RecordsMessage>;

  const stats = state.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t("stats.events")}
          value={stats.events}
          hint={t("stats.sessions", { count: stats.sessions })}
        />
        <StatCard label={t("stats.findings")} value={stats.findings} />
        <StatCard
          label={t("stats.jevCalls")}
          value={stats.jevCalls}
          hint={t("stats.jevCallsHint", {
            candidates: stats.jevCandidates,
            failed: stats.jevFailed,
            timedOut: stats.jevTimedOut,
          })}
        />
        <StatCard
          label={t("stats.jevRules")}
          value={stats.jevActiveRules + stats.jevPendingRules}
          hint={t("stats.jevRulesHint", {
            active: stats.jevActiveRules,
            pending: stats.jevPendingRules,
          })}
        />
      </div>

      {stats.pendingReview > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span>{t("stats.pendingReview", { count: stats.pendingReview })}</span>
          <Link
            href="/settings/redaction"
            className="font-medium underline-offset-2 hover:underline"
          >
            {t("stats.pendingReviewLink")}
          </Link>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("stats.topRules")}</p>
        {stats.topRules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("stats.noTopRules")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {stats.topRules.map((rule) => (
              <Badge key={rule.ruleId} variant="secondary" className="gap-1">
                {ruleName(rule.ruleId, rule.ruleName)}
                <span className="tabular-nums text-muted-foreground">{rule.count}</span>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
