"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { redactionApi } from "@/lib/redaction/client-api";
import type { RedactionEventListItem } from "@/lib/redaction/types";
import { RedactionFindingsList } from "../../logs/_components/redaction/redaction-findings";
import { useRedactionRuleName } from "../../logs/_components/redaction/use-rule-name";
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

const MAX_RULE_BADGES = 3;

function EventRow({ item }: { item: RedactionEventListItem }) {
  const t = useTranslations("settings.redaction.records.events");
  const ruleName = useRedactionRuleName();
  const formatTime = useRecordTime();
  const [open, setOpen] = useState(false);

  const rules = new Map<string, string>();
  for (const finding of item.findings) {
    if (!rules.has(finding.ruleId))
      rules.set(finding.ruleId, ruleName(finding.ruleId, finding.ruleName));
  }
  const ruleBadges = [...rules.entries()];

  return (
    <li className="rounded-md border">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 p-3 text-sm">
        <span className="font-mono text-xs text-muted-foreground">
          {formatTime(item.createdAt)}
        </span>
        <span>{ownerLabel(item)}</span>
        {item.model && <Badge variant="outline">{item.model}</Badge>}
        <SessionLink sessionId={item.sessionId} sequence={item.requestSequence} />
        <span className="font-medium">
          {t("masked", { count: item.newCount, total: item.totalCount })}
        </span>
        <span className="flex flex-wrap gap-1">
          {ruleBadges.slice(0, MAX_RULE_BADGES).map(([ruleId, name]) => (
            <Badge key={ruleId} variant="secondary">
              {name}
            </Badge>
          ))}
          {ruleBadges.length > MAX_RULE_BADGES && (
            <Badge variant="secondary">+{ruleBadges.length - MAX_RULE_BADGES}</Badge>
          )}
        </span>
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
        <div className="border-t p-3">
          <RedactionFindingsList events={[item]} />
        </div>
      )}
    </li>
  );
}

export function RedactionEventsList({ range }: { range: RecordsRangeQuery }) {
  const t = useTranslations("settings.redaction.records");
  const [page, setPage] = useState(1);
  const load = useCallback(
    () => redactionApi.listRecordEvents({ ...range, page, pageSize: RECORDS_PAGE_SIZE }),
    [range, page]
  );
  const state = useActionResource(load);

  if (state.status === "loading") return <RecordsMessage>{t("loading")}</RecordsMessage>;
  if (state.status === "error")
    return <RecordsMessage tone="error">{t("loadFailed")}</RecordsMessage>;

  const { items, hasMore } = state.data;
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <RecordsMessage>{t("events.empty")}</RecordsMessage>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <EventRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      <RecordsPager page={page} hasMore={hasMore} onChange={setPage} />
    </div>
  );
}
