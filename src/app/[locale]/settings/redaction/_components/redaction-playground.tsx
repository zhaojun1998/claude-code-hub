"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useRedactionRuleName } from "@/app/[locale]/dashboard/logs/_components/redaction/use-rule-name";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RedactionPreview } from "@/lib/redaction/api-types";
import { redactionApi } from "@/lib/redaction/client-api";
import { useRedactionError } from "./use-redaction-error";

export function RedactionPlayground() {
  const t = useTranslations("settings.redaction");
  const describeError = useRedactionError();
  const ruleName = useRedactionRuleName();
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<RedactionPreview | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const result = await redactionApi.preview(text);
      if (result.ok) setPreview(result.data);
      else toast.error(describeError(result));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("playground.description")}</p>
      <Textarea
        rows={8}
        value={text}
        placeholder={t("playground.placeholder")}
        className="font-mono text-xs"
        onChange={(event) => setText(event.target.value)}
      />
      <Button onClick={run} disabled={running || text.length === 0}>
        {running ? t("playground.running") : t("playground.run")}
      </Button>

      {preview && (
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("playground.result")}</h4>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {preview.redactedText}
            </pre>
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("playground.matches")}</h4>
            {preview.redactions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("playground.noMatches")}</p>
            ) : (
              <ul className="space-y-1">
                {preview.redactions.map((item) => (
                  <li
                    key={`${item.start}-${item.ruleId}`}
                    className="flex flex-wrap items-center gap-2 font-mono text-xs"
                  >
                    <Badge variant="outline">{ruleName(item.ruleId, item.ruleName)}</Badge>
                    <span className="break-all text-destructive">{item.original}</span>
                    <span className="text-muted-foreground">-&gt;</span>
                    <span className="break-all text-emerald-600 dark:text-emerald-400">
                      {item.replacement}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("playground.candidates")}</h4>
            <p className="text-xs text-muted-foreground">{t("playground.candidatesHint")}</p>
            {preview.candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("playground.noCandidates")}</p>
            ) : (
              <ul className="space-y-1">
                {preview.candidates.map((candidate) => (
                  <li key={candidate.preview} className="flex items-center gap-2 font-mono text-xs">
                    <Badge variant="secondary">{t(`playground.hint.${candidate.hint}`)}</Badge>
                    {candidate.keyName && (
                      <span className="text-muted-foreground">{candidate.keyName}</span>
                    )}
                    <span>{candidate.preview}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
