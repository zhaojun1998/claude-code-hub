import { getTranslations } from "next-intl/server";
import { Section } from "@/components/section";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { RedactionRecordsView } from "./_components/redaction-records-view";

export const dynamic = "force-dynamic";

/** Redaction records and Jev discovery calls (fork feature, admin only). */
export default async function RedactionRecordsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();
  if (session?.user.role !== "admin") {
    return redirect({ href: "/dashboard", locale });
  }
  const t = await getTranslations({ locale, namespace: "settings.redaction.records" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("description")}</p>
      </div>
      <Section>
        <RedactionRecordsView />
      </Section>
    </div>
  );
}
