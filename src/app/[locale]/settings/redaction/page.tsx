import { getTranslations } from "next-intl/server";
import { Section } from "@/components/section";
import { getRedactionOverviewAction } from "@/lib/redaction/service";
import { SettingsPageHeader } from "../_components/settings-page-header";
import { RedactionSettingsView } from "./_components/redaction-settings-view";

export const dynamic = "force-dynamic";

export default async function RedactionSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings.redaction" });
  const overview = await getRedactionOverviewAction();

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} icon="shield-alert" />
      <Section
        title={t("title")}
        description={t("description")}
        icon="shield-alert"
        iconColor="text-primary"
        variant="default"
      >
        {overview.ok ? (
          <RedactionSettingsView initialOverview={overview.data} />
        ) : (
          <p className="text-sm text-destructive">
            {t(`errors.${overview.errorCode ?? "LOAD_FAILED"}`)}
          </p>
        )}
      </Section>
    </>
  );
}
