"use client";

import { Check, Eye, EyeOff, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { redactionApi } from "@/lib/redaction/client-api";
import { maskValue } from "@/lib/redaction/mask";
import type { DiscoveredRuleStatus, StoredRedactionRule } from "@/lib/redaction/types";
import { RuleDialog } from "./rule-dialog";
import { useRedactionError } from "./use-redaction-error";

type Filter = "all" | DiscoveredRuleStatus;

const FILTERS: Filter[] = ["all", "active", "pending", "rejected"];

const STATUS_VARIANT: Record<DiscoveredRuleStatus, "default" | "secondary" | "outline"> = {
  active: "default",
  pending: "secondary",
  rejected: "outline",
};

interface StoredRulesTableProps {
  rules: StoredRedactionRule[];
  onChanged: () => Promise<void> | void;
}

export function StoredRulesTable({ rules, onChanged }: StoredRulesTableProps) {
  const t = useTranslations("settings.redaction");
  const describeError = useRedactionError();
  const [filter, setFilter] = useState<Filter>("all");
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StoredRedactionRule | null>(null);

  const visible = useMemo(
    () => rules.filter((rule) => filter === "all" || rule.status === filter),
    [rules, filter]
  );

  const run = async (
    action: () => Promise<{ ok: boolean; errorCode?: string }>,
    success: string
  ) => {
    const result = await action();
    if (result.ok) {
      toast.success(success);
      await onChanged();
    } else {
      toast.error(describeError(result));
    }
  };

  const toggleReveal = (id: number) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("rules.description")}</p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("rules.add")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <Button
            key={item}
            size="sm"
            variant={filter === item ? "default" : "outline"}
            onClick={() => setFilter(item)}
          >
            {t(`rules.filter.${item}`)}
          </Button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("rules.columns.name")}</TableHead>
              <TableHead>{t("rules.columns.source")}</TableHead>
              <TableHead>{t("rules.columns.pattern")}</TableHead>
              <TableHead>{t("rules.columns.confidence")}</TableHead>
              <TableHead>{t("rules.columns.hits")}</TableHead>
              <TableHead>{t("rules.columns.status")}</TableHead>
              <TableHead className="text-right">{t("rules.columns.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  {t("rules.empty")}
                </TableCell>
              </TableRow>
            )}
            {visible.map((rule) => {
              const hidden = rule.kind === "literal" && !revealed.has(rule.id);
              return (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="font-medium">{rule.name}</div>
                    <div className="flex gap-1 pt-1">
                      <Badge variant="outline">{t(`category.${rule.category}`)}</Badge>
                      <Badge variant="outline" className="font-mono">
                        {rule.label}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{t(`rules.source.${rule.source}`)}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`rules.kind.${rule.kind}`)}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    <div className="flex items-center gap-1">
                      <code className="truncate text-xs">
                        {hidden ? maskValue(rule.pattern) : rule.pattern}
                      </code>
                      {rule.kind === "literal" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0"
                          aria-label={hidden ? t("rules.reveal") : t("rules.hide")}
                          onClick={() => toggleReveal(rule.id)}
                        >
                          {hidden ? (
                            <Eye className="h-3.5 w-3.5" />
                          ) : (
                            <EyeOff className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {rule.confidence === null ? "-" : rule.confidence.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-xs">{rule.hitCount}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[rule.status]}>
                      {t(`rules.status.${rule.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {rule.status !== "active" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label={t("rules.approve")}
                          title={t("rules.approve")}
                          onClick={() =>
                            run(
                              () => redactionApi.setRuleStatus(rule.id, "active"),
                              t("rules.updated")
                            )
                          }
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                      )}
                      {rule.status !== "rejected" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label={t("rules.reject")}
                          title={t("rules.reject")}
                          onClick={() =>
                            run(
                              () => redactionApi.setRuleStatus(rule.id, "rejected"),
                              t("rules.updated")
                            )
                          }
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={t("rules.edit")}
                        title={t("rules.edit")}
                        onClick={() => {
                          setEditing(rule);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        aria-label={t("rules.delete")}
                        title={t("rules.delete")}
                        onClick={() => {
                          if (window.confirm(t("rules.confirmDelete", { name: rule.name }))) {
                            void run(() => redactionApi.deleteRule(rule.id), t("rules.deleted"));
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <RuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
        onSaved={onChanged}
      />
    </div>
  );
}
