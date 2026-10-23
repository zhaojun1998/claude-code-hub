"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/routing";
import { JevCallsList } from "./jev-calls-list";
import type { RecordsRangeQuery } from "./records-shared";
import { RecordsStats } from "./records-stats";
import { RedactionEventsList } from "./redaction-events-list";

export type RecordsRangeKey = "24h" | "7d" | "30d" | "all";

const RANGES: RecordsRangeKey[] = ["24h", "7d", "30d", "all"];

const HOUR_MS = 60 * 60 * 1000;

const RANGE_MS: Record<Exclude<RecordsRangeKey, "all">, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};

/** Records created in `[now - range, now]`; refreshing moves `now`. */
export function buildRecordsRange(range: RecordsRangeKey, now: number): RecordsRangeQuery {
  return {
    from: range === "all" ? undefined : new Date(now - RANGE_MS[range]).toISOString(),
    // `to` is exclusive; include records written in the same millisecond as the refresh.
    to: new Date(now + 1).toISOString(),
  };
}

export function RedactionRecordsView() {
  const t = useTranslations("settings.redaction.records");
  const [rangeKey, setRangeKey] = useState<RecordsRangeKey>("7d");
  const [now, setNow] = useState(() => Date.now());
  const range = useMemo(() => buildRecordsRange(rangeKey, now), [rangeKey, now]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={rangeKey} onValueChange={(next) => setRangeKey(next as RecordsRangeKey)}>
          <SelectTrigger className="w-[180px]" aria-label={t("range.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`range.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/redaction">{t("settingsLink")}</Link>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setNow(Date.now())}>
            <RefreshCw className="h-4 w-4" />
            {t("refresh")}
          </Button>
        </div>
      </div>

      <RecordsStats range={range} />

      <Tabs defaultValue="events" className="space-y-3">
        <TabsList>
          <TabsTrigger value="events">{t("tabs.events")}</TabsTrigger>
          <TabsTrigger value="jev">{t("tabs.jev")}</TabsTrigger>
        </TabsList>
        <TabsContent value="events">
          {/* Remounting resets the page when the range changes; a refresh keeps it. */}
          <RedactionEventsList key={rangeKey} range={range} />
        </TabsContent>
        <TabsContent value="jev">
          <JevCallsList key={rangeKey} range={range} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
