import fs from "node:fs";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import RedactionRecordsPage, { dynamic } from "@/app/[locale]/dashboard/redaction/page";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
}));

vi.mock("@/i18n/routing", () => ({
  redirect: mocks.redirect,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}));

vi.mock("@/components/section", () => ({
  Section: ({ children }: { children?: ReactNode }) => (
    <section data-testid="section">{children}</section>
  ),
}));

vi.mock("@/app/[locale]/dashboard/redaction/_components/redaction-records-view", () => ({
  RedactionRecordsView: () => <div data-testid="records-view" />,
}));

const records = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "messages/en/settings/redaction.json"), "utf8")
).records as Record<string, string>;

const REDIRECTED = Symbol("redirected");

function params(locale: string) {
  return { params: Promise.resolve({ locale }) };
}

function session(role: "admin" | "user") {
  return { user: { id: 1, name: "Ada", role }, key: { id: 2, canLoginWebUi: true } };
}

beforeEach(() => {
  mocks.redirect.mockReturnValue(REDIRECTED);
  mocks.getTranslations.mockResolvedValue((key: string) => records[key] ?? key);
});

describe("RedactionRecordsPage", () => {
  test("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("redirects regular users to the dashboard in their locale", async () => {
    mocks.getSession.mockResolvedValue(session("user"));

    const result = await RedactionRecordsPage(params("ja"));

    expect(result).toBe(REDIRECTED);
    expect(mocks.redirect).toHaveBeenCalledWith({ href: "/dashboard", locale: "ja" });
    expect(mocks.getTranslations).not.toHaveBeenCalled();
  });

  test("redirects when there is no session", async () => {
    mocks.getSession.mockResolvedValue(null);

    await RedactionRecordsPage(params("en"));

    expect(mocks.redirect).toHaveBeenCalledWith({ href: "/dashboard", locale: "en" });
  });

  test("renders the title, description and records view for admins", async () => {
    mocks.getSession.mockResolvedValue(session("admin"));

    const element = await RedactionRecordsPage(params("en"));
    const html = renderToString(element as ReactElement);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getTranslations).toHaveBeenCalledWith({
      locale: "en",
      namespace: "settings.redaction.records",
    });
    expect(html).toContain(`<h1 class="text-3xl font-bold tracking-tight">${records.title}</h1>`);
    expect(html).toContain(records.description);
    expect(html).toMatch(/<section data-testid="section"><div data-testid="records-view"><\/div>/);
  });
});
