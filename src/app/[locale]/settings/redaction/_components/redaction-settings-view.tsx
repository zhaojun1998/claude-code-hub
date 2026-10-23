"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RedactionOverview } from "@/lib/redaction/api-types";
import { redactionApi } from "@/lib/redaction/client-api";
import { BuiltinRulesTable } from "./builtin-rules-table";
import { GeneralSettingsForm } from "./general-settings-form";
import { JevSettingsForm } from "./jev-settings-form";
import { RedactionPlayground } from "./redaction-playground";
import { StoredRulesTable } from "./stored-rules-table";

export function RedactionSettingsView({ initialOverview }: { initialOverview: RedactionOverview }) {
  const t = useTranslations("settings.redaction");
  const [overview, setOverview] = useState(initialOverview);
  // Bumped on every reload so the forms remount with the server's normalized values.
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => {
    const result = await redactionApi.getOverview();
    if (result.ok) {
      setOverview(result.data);
      setVersion((current) => current + 1);
    }
  }, []);

  const pendingCount = overview.rules.filter((rule) => rule.status === "pending").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant={overview.settings.enabled ? "default" : "secondary"}>
          {overview.settings.enabled ? t("general.statusOn") : t("general.statusOff")}
        </Badge>
      </div>
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="general">{t("tabs.general")}</TabsTrigger>
          <TabsTrigger value="builtin">{t("tabs.builtin")}</TabsTrigger>
          <TabsTrigger value="rules">
            {t("tabs.rules")}
            {pendingCount > 0 && (
              <Badge variant="destructive" className="ml-1.5 h-5 px-1.5">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="jev">{t("tabs.jev")}</TabsTrigger>
          <TabsTrigger value="playground">{t("tabs.playground")}</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="mt-4">
          <GeneralSettingsForm key={version} settings={overview.settings} onSaved={refresh} />
        </TabsContent>
        <TabsContent value="builtin" className="mt-4">
          <BuiltinRulesTable rules={overview.builtinRules} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <StoredRulesTable rules={overview.rules} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="jev" className="mt-4">
          <JevSettingsForm
            key={version}
            settings={overview.settings}
            verdicts={overview.verdicts}
            onSaved={refresh}
          />
        </TabsContent>
        <TabsContent value="playground" className="mt-4">
          <RedactionPlayground />
        </TabsContent>
      </Tabs>
    </div>
  );
}
