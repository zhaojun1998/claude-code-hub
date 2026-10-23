"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useRedactionRuleName } from "@/app/[locale]/dashboard/logs/_components/redaction/use-rule-name";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BuiltinRuleView } from "@/lib/redaction/api-types";
import { redactionApi } from "@/lib/redaction/client-api";
import { useRedactionError } from "./use-redaction-error";

interface BuiltinRulesTableProps {
  rules: BuiltinRuleView[];
  onChanged: () => Promise<void> | void;
}

export function BuiltinRulesTable({ rules, onChanged }: BuiltinRulesTableProps) {
  const t = useTranslations("settings.redaction");
  const describeError = useRedactionError();
  const ruleName = useRedactionRuleName();
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (rule: BuiltinRuleView, enabled: boolean) => {
    setBusy(rule.id);
    try {
      const result = await redactionApi.setBuiltinRuleEnabled(rule.id, enabled);
      if (result.ok) {
        toast.success(t("builtin.updated"));
        await onChanged();
      } else {
        toast.error(describeError(result));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("builtin.description")}</p>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("builtin.columns.name")}</TableHead>
              <TableHead>{t("builtin.columns.category")}</TableHead>
              <TableHead>{t("builtin.columns.label")}</TableHead>
              <TableHead className="hidden lg:table-cell">{t("builtin.columns.example")}</TableHead>
              <TableHead className="text-right">{t("builtin.columns.enabled")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>
                  <div className="font-medium">{ruleName(rule.id, rule.name)}</div>
                  <div className="text-xs text-muted-foreground">
                    {rule.defaultEnabled ? t("builtin.defaultOn") : t("builtin.defaultOff")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{t(`category.${rule.category}`)}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{rule.label}</TableCell>
                <TableCell className="hidden max-w-[320px] truncate font-mono text-xs text-muted-foreground lg:table-cell">
                  {rule.example?.split("\n")[0]}
                </TableCell>
                <TableCell className="text-right">
                  <Switch
                    checked={rule.enabled}
                    disabled={busy === rule.id}
                    onCheckedChange={(checked) => toggle(rule, checked)}
                    aria-label={ruleName(rule.id, rule.name)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
