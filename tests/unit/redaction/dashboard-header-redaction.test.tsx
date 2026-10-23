import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { DashboardHeader } from "@/app/[locale]/dashboard/_components/dashboard-header";
import type { AuthSession } from "@/lib/auth";

const translations: Record<string, Record<string, string>> = {
  "dashboard.nav": {
    availability: "Availability",
    dashboard: "Dashboard",
    documentation: "Docs",
    leaderboard: "Leaderboard",
    login: "Login",
    myQuota: "My Quota",
    providers: "Providers",
    quotasManagement: "Quotas",
    systemSettings: "Settings",
    usageLogs: "Usage Logs",
    userManagement: "Users",
  },
  "settings.redaction.records": {
    nav: "Redaction Records",
  },
};

vi.mock("next-intl/server", () => ({
  getTranslations:
    ({ namespace }: { namespace: string }) =>
    (key: string) =>
      translations[namespace]?.[key] ?? `${namespace}.${key}`,
}));

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/customs/version-update-notifier", () => ({
  VersionUpdateNotifier: () => <span data-testid="version-update" />,
}));

vi.mock("@/components/ui/language-switcher", () => ({
  LanguageSwitcher: () => <span data-testid="language-switcher" />,
}));

vi.mock("@/components/ui/theme-switcher", () => ({
  ThemeSwitcher: () => <span data-testid="theme-switcher" />,
}));

vi.mock("@/app/[locale]/dashboard/_components/dashboard-nav", () => ({
  DashboardNav: ({ items }: { items: { href: string; label: string }[] }) => (
    <nav data-testid="desktop-nav">
      {items.map((item) => (
        <a href={item.href} key={item.href}>
          {item.label}
        </a>
      ))}
    </nav>
  ),
}));

vi.mock("@/app/[locale]/dashboard/_components/mobile-nav", () => ({
  MobileNav: ({ items }: { items: { href: string; label: string }[] }) => (
    <nav data-testid="mobile-nav">
      {items.map((item) => (
        <a href={item.href} key={item.href}>
          {item.label}
        </a>
      ))}
    </nav>
  ),
}));

vi.mock("@/app/[locale]/dashboard/_components/user-menu", () => ({
  UserMenu: ({ user }: { user: { name: string } }) => (
    <span data-testid="user-menu">{user.name}</span>
  ),
}));

function buildSession(role: "admin" | "user", canLoginWebUi = true): AuthSession {
  return {
    user: { id: 1, name: "Ada Lovelace", role },
    key: { id: 10, name: "web-key", key: "sk-test-key", userId: 1, canLoginWebUi },
  } as AuthSession;
}

const redactionLink = '<a href="/dashboard/redaction">Redaction Records</a>';

function countOf(html: string, needle: string) {
  return html.split(needle).length - 1;
}

describe("DashboardHeader redaction nav item", () => {
  test("admins see the redaction records link in both navs, after the usage logs", async () => {
    const html = renderToString(
      await DashboardHeader({ session: buildSession("admin"), locale: "en" })
    );

    expect(html).toContain('href="/dashboard/redaction"');
    expect(countOf(html, redactionLink)).toBe(2);
    expect(html).toContain(
      `<a href="/dashboard/logs">Usage Logs</a>${redactionLink}<a href="/dashboard/leaderboard">`
    );
  });

  test("admins see it even when their key cannot log in to the web UI", async () => {
    const html = renderToString(
      await DashboardHeader({ session: buildSession("admin", false), locale: "en" })
    );

    expect(html).toContain('href="/dashboard/redaction"');
  });

  test("regular users do not see the redaction records link", async () => {
    const html = renderToString(
      await DashboardHeader({ session: buildSession("user"), locale: "en" })
    );

    expect(html).toContain('href="/dashboard/logs"');
    expect(html).not.toContain('href="/dashboard/redaction"');
    expect(html).not.toContain("Redaction Records");
  });

  test("read-only and anonymous visitors do not see it either", async () => {
    const readonly = renderToString(
      await DashboardHeader({ session: buildSession("user", false), locale: "en" })
    );
    const anonymous = renderToString(await DashboardHeader({ session: null, locale: "en" }));

    expect(readonly).not.toContain('href="/dashboard/redaction"');
    expect(anonymous).not.toContain('href="/dashboard/redaction"');
  });
});
