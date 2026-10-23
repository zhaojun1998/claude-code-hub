"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { redactionApi } from "@/lib/redaction/client-api";
import type {
  JevCallRecord,
  JevCallsFilter,
  JevCandidateOutcome,
  JevCandidateResult,
} from "@/lib/redaction/types";
import {
  ownerLabel,
  RECORDS_PAGE_SIZE,
  RecordsMessage,
  RecordsPager,
  type RecordsRangeQuery,
  SessionLink,
  useRecordTime,
} from "./records-shared";
import { useActionResource } from "./use-action-resource";

const FILTERS: JevCallsFilter[] = ["all", "discovered", "failed"];

const OUTCOME_CLASSES: Record<JevCandidateOutcome, string> = {
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  existing: "",
  benign: "",
  low_confidence: "",
  unjudged: "border-destructive/40 text-destructive",
  failed: "border-destructive/40 text-destructive",
};

function CallStatus({ call }: { call: JevCallRecord }) {
  const t = useTranslations("settings.redaction.records.jev.status");
  if (!call.ok) return <Badge variant="destructive">{t("failed")}</Badge>;
  if (call.timedOut) return <Badge variant="secondary">{t("timedOut")}</Badge>;
  return <Badge variant="outline">{t("ok")}</Badge>;
}

function CandidateRow({ result }: { result: JevCandidateResult }) {
  const t = useTranslations("settings.redaction");
  const hintKey = `playground.hint.${result.hint}`;
  const categoryKey = `records.jev.category.${result.category}`;
  return (
    <li className="space-y-1 rounded-md border p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={OUTCOME_CLASSES[result.outcome]}>
          {t(`records.jev.outcome.${result.outcome}`)}
        </Badge>
        {result.category && (
          <Badge variant="secondary">{t.has(categoryKey) ? t(categoryKey) : result.category}</Badge>
        )}
        {result.confidence !== null && (
          <span className="tabular-nums text-muted-foreground">
            {t("records.jev.confidence", { value: Math.round(result.confidence * 100) })}
          </span>
        )}
        {result.ruleIds.length > 0 && (
          <span className="text-muted-foreground">
            {t("records.jev.ruleIds", { ids: result.ruleIds.map((id) => `#${id}`).join(", ") })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-1">
        <span className="text-muted-foreground">{t("records.jev.value")}</span>
        <code className="break-all rounded bg-muted px-1">{result.value}</code>
        <span className="text-muted-foreground">{t("records.jev.signal")}</span>
        <span>
          {t.has(hintKey) ? t(hintKey) : result.hint}
          {result.keyName ? ` (${result.keyName})` : ""}
        </span>
        <span className="text-muted-foreground">{t("logs.location")}</span>
        <code className="break-all text-muted-foreground">{result.path}</code>
      </div>
    </li>
  );
}

function CallRow({ call }: { call: JevCallRecord }) {
  const t = useTranslations("settings.redaction.records.jev");
  const formatTime = useRecordTime();
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded-md border">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 p-3 text-sm">
        <span className="font-mono text-xs text-muted-foreground">
          {formatTime(call.createdAt)}
        </span>
        <span>{ownerLabel(call)}</span>
        <SessionLink sessionId={call.sessionId} sequence={call.requestSequence} />
        <span className="text-xs text-muted-foreground">
          {call.model ?? "-"} · {t(`mode.${call.mode === "sync" ? "sync" : "async"}`)} ·{" "}
          {t(`sendMode.${call.sendMode === "full" ? "full" : "masked"}`)}
        </span>
        <span>{t("summary", { candidates: call.candidateCount, judged: call.judgedCount })}</span>
        {call.activeRules > 0 && (
          <Badge variant="outline" className={OUTCOME_CLASSES.active}>
            {t("activeRules", { count: call.activeRules })}
          </Badge>
        )}
        {call.pendingRules > 0 && (
          <Badge variant="outline" className={OUTCOME_CLASSES.pending}>
            {t("pendingRules", { count: call.pendingRules })}
          </Badge>
        )}
        <span className="tabular-nums text-xs text-muted-foreground">
          {t("duration", { ms: call.durationMs })}
        </span>
        <CallStatus call={call} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? t("hide") : t("details")}
        </Button>
      </div>
      {open && (
        <div className="space-y-2 border-t p-3">
          {call.error && (
            <p className="text-xs text-destructive">{t("error", { error: call.error })}</p>
          )}
          {call.inputTokens !== null && (
            <p className="text-xs text-muted-foreground">
              {t("tokens", { count: call.inputTokens })}
            </p>
          )}
          {!call.originalsRecorded && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("maskedValues")}</p>
          )}
          <ul className="space-y-2">
            {call.results.map((result, index) => (
              <CandidateRow key={`${result.path}-${index}`} result={result} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function JevCallsList({ range }: { range: RecordsRangeQuery }) {
  const t = useTranslations("settings.redaction.records");
  const [filter, setFilter] = useState<JevCallsFilter>("all");
  const [page, setPage] = useState(1);
  const load = useCallback(
    () => redactionApi.listJevCalls({ ...range, filter, page, pageSize: RECORDS_PAGE_SIZE }),
    [range, filter, page]
  );
  const state = useActionResource(load);

  const filterSelect = (
    <Select
      value={filter}
      onValueChange={(next) => {
        setFilter(next as JevCallsFilter);
        setPage(1);
      }}
    >
      <SelectTrigger className="w-[200px]" aria-label={t("jev.filterLabel")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FILTERS.map((item) => (
          <SelectItem key={item} value={item}>
            {t(`jev.filter.${item}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  let body: ReactNode;
  if (state.status === "loading") {
    body = <RecordsMessage>{t("loading")}</RecordsMessage>;
  } else if (state.status === "error") {
    body = <RecordsMessage tone="error">{t("loadFailed")}</RecordsMessage>;
  } else if (state.data.items.length === 0) {
    body = (
      <div className="space-y-1">
        <RecordsMessage>{t("jev.empty")}</RecordsMessage>
        <p className="text-center text-xs text-muted-foreground">{t("jev.emptyHint")}</p>
      </div>
    );
  } else {
    body = (
      <ul className="space-y-2">
        {state.data.items.map((call) => (
          <CallRow key={call.id} call={call} />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-3">
      {filterSelect}
      {body}
      {state.status === "ready" && (
        <RecordsPager page={page} hasMore={state.data.hasMore} onChange={setPage} />
      )}
    </div>
  );
}
