"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/routing";

export interface RecordsRangeQuery {
  from?: string;
  to: string;
}

export const RECORDS_PAGE_SIZE = 20;

export function useRecordTime() {
  const format = useFormatter();
  return (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "short", timeStyle: "medium" });
}

/** "user / key" of a record; ids stand in for deleted users or keys. */
export function ownerLabel(record: {
  userId: number | null;
  userName: string | null;
  keyId: number | null;
  keyName: string | null;
}): string {
  const user = record.userName ?? (record.userId === null ? "-" : `#${record.userId}`);
  const key = record.keyName ?? (record.keyId === null ? "-" : `#${record.keyId}`);
  return `${user} / ${key}`;
}

/** Link to the usage logs filtered to the record's session. */
export function SessionLink({
  sessionId,
  sequence,
}: {
  sessionId: string | null;
  sequence: number | null;
}) {
  if (!sessionId) return <span className="text-muted-foreground">-</span>;
  const short = sessionId.length > 14 ? `${sessionId.slice(0, 14)}...` : sessionId;
  return (
    <Link
      href={`/dashboard/logs?sessionId=${encodeURIComponent(sessionId)}`}
      className="font-mono text-xs underline-offset-2 hover:underline"
      title={sessionId}
    >
      {short}
      {sequence !== null ? ` #${sequence}` : ""}
    </Link>
  );
}

export function RecordsPager({
  page,
  hasMore,
  onChange,
}: {
  page: number;
  hasMore: boolean;
  onChange: (page: number) => void;
}) {
  const t = useTranslations("settings.redaction.records.pager");
  if (page === 1 && !hasMore) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        {t("prev")}
      </Button>
      <span className="text-muted-foreground">{t("page", { page })}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!hasMore}
        onClick={() => onChange(page + 1)}
      >
        {t("next")}
      </Button>
    </div>
  );
}

export function RecordsMessage({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <p
      className={
        tone === "error"
          ? "py-6 text-center text-sm text-destructive"
          : "py-6 text-center text-sm text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}
