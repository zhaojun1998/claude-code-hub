"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RuleFormInput } from "@/lib/redaction/api-types";
import { redactionApi } from "@/lib/redaction/client-api";
import type {
  RedactionCategory,
  RedactionRuleKind,
  StoredRedactionRule,
} from "@/lib/redaction/types";
import { useRedactionError } from "./use-redaction-error";

const CATEGORIES: RedactionCategory[] = ["secret", "pii", "network", "custom"];

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: StoredRedactionRule | null;
  onSaved: () => Promise<void> | void;
}

function emptyForm(): RuleFormInput {
  return {
    name: "",
    category: "secret",
    label: "SECRET",
    kind: "regex",
    pattern: "",
    flags: "",
    groupIndex: 0,
    description: "",
  };
}

export function RuleDialog({ open, onOpenChange, rule, onSaved }: RuleDialogProps) {
  const t = useTranslations("settings.redaction");
  const describeError = useRedactionError();
  const [form, setForm] = useState<RuleFormInput>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(
      rule
        ? {
            name: rule.name,
            category: rule.category,
            label: rule.label,
            kind: rule.kind,
            pattern: rule.pattern,
            flags: rule.flags ?? "",
            groupIndex: rule.groupIndex ?? 0,
            description: rule.description ?? "",
            status: rule.status,
          }
        : emptyForm()
    );
  }, [open, rule]);

  const update = <K extends keyof RuleFormInput>(key: K, next: RuleFormInput[K]) =>
    setForm((current) => ({ ...current, [key]: next }));

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const result = rule
        ? await redactionApi.updateRule(rule.id, form)
        : await redactionApi.createRule(form);
      if (result.ok) {
        toast.success(rule ? t("rules.updated") : t("rules.created"));
        onOpenChange(false);
        await onSaved();
      } else {
        toast.error(describeError(result));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {rule ? t("rules.dialog.editTitle") : t("rules.dialog.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("rules.dialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="rule-name">{t("rules.dialog.name")}</Label>
            <Input
              id="rule-name"
              value={form.name}
              placeholder={t("rules.dialog.namePlaceholder")}
              onChange={(event) => update("name", event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("rules.dialog.category")}</Label>
              <Select
                value={form.category}
                onValueChange={(next) => update("category", next as RedactionCategory)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {t(`category.${category}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("rules.dialog.kind")}</Label>
              <Select
                value={form.kind}
                onValueChange={(next) => update("kind", next as RedactionRuleKind)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="regex">{t("rules.kind.regex")}</SelectItem>
                  <SelectItem value="literal">{t("rules.kind.literal")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rule-label">{t("rules.dialog.label")}</Label>
            <Input
              id="rule-label"
              value={form.label}
              className="font-mono"
              onChange={(event) => update("label", event.target.value.toUpperCase())}
            />
            <p className="text-xs text-muted-foreground">{t("rules.dialog.labelHint")}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rule-pattern">{t("rules.dialog.pattern")}</Label>
            <Textarea
              id="rule-pattern"
              rows={3}
              value={form.pattern}
              className="font-mono text-xs"
              placeholder={
                form.kind === "regex"
                  ? t("rules.dialog.patternRegexPlaceholder", { example: "acme_[A-Za-z0-9]{32}" })
                  : t("rules.dialog.patternLiteralPlaceholder")
              }
              onChange={(event) => update("pattern", event.target.value)}
            />
          </div>
          {form.kind === "regex" && (
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="rule-flags">{t("rules.dialog.flags")}</Label>
                <Input
                  id="rule-flags"
                  value={form.flags ?? ""}
                  className="font-mono"
                  onChange={(event) => update("flags", event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("rules.dialog.flagsHint")}</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rule-group">{t("rules.dialog.group")}</Label>
                <Input
                  id="rule-group"
                  type="number"
                  min={0}
                  max={9}
                  value={String(form.groupIndex ?? 0)}
                  onChange={(event) => update("groupIndex", Number(event.target.value))}
                />
                <p className="text-xs text-muted-foreground">{t("rules.dialog.groupHint")}</p>
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="rule-description">{t("rules.dialog.descriptionLabel")}</Label>
            <Input
              id="rule-description"
              value={form.description ?? ""}
              onChange={(event) => update("description", event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("rules.dialog.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {t("rules.dialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
