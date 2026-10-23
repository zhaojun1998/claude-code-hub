import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/lib/api-client/v1/errors";
import { redactionApi, toErrorCode } from "@/lib/redaction/client-api";

type Call = { url: string; method: string; body: unknown; headers: Headers };

let calls: Call[] = [];
let nextResponse: () => Response;

function json(body: unknown, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
}

beforeEach(() => {
  calls = [];
  nextResponse = () => json({ done: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/v1/auth/csrf") return json({ csrfToken: "csrf-1" });
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init.headers),
      });
      return nextResponse();
    })
  );
});

describe("redaction client api", () => {
  test("each method hits its route", async () => {
    const form = {
      name: "Acme",
      category: "secret" as const,
      label: "ACME",
      kind: "literal" as const,
      pattern: "acme-secret",
    };
    await redactionApi.getOverview();
    await redactionApi.saveSettings({ enabled: true });
    await redactionApi.setBuiltinRuleEnabled("builtin:email", false);
    await redactionApi.createRule(form);
    await redactionApi.updateRule(3, form);
    await redactionApi.setRuleStatus(3, "rejected");
    await redactionApi.deleteRule(3);
    await redactionApi.preview("text");
    await redactionApi.testJev();
    await redactionApi.clearJevVerdicts();
    await redactionApi.getSummaries([1, 2]);
    await redactionApi.getEvents(8);
    await redactionApi.getRecordStats({ from: "2026-01-01T00:00:00.000Z", to: null });
    await redactionApi.listRecordEvents({ page: 2, pageSize: 20, sessionId: "" });
    await redactionApi.listJevCalls({ filter: "discovered" });
    await redactionApi.listJevCalls();

    const base = "/api/fork/redaction";
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${base}/overview`,
      `PUT ${base}/settings`,
      `PUT ${base}/builtin-rules`,
      `POST ${base}/rules`,
      `PUT ${base}/rules/3`,
      `PUT ${base}/rules/3/status`,
      `DELETE ${base}/rules/3`,
      `POST ${base}/preview`,
      `POST ${base}/jev/test`,
      `DELETE ${base}/jev/verdicts`,
      `GET ${base}/summaries?ids=1,2`,
      `GET ${base}/requests/8/events`,
      `GET ${base}/records/stats?from=2026-01-01T00%3A00%3A00.000Z`,
      `GET ${base}/records/events?page=2&pageSize=20`,
      `GET ${base}/records/jev-calls?filter=discovered`,
      `GET ${base}/records/jev-calls`,
    ]);
    expect(calls[2].body).toEqual({ ruleId: "builtin:email", enabled: false });
    expect(calls[5].body).toEqual({ status: "rejected" });
    expect(calls[7].body).toEqual({ text: "text" });
    // Mutations carry the CSRF token, reads do not.
    expect(calls[1].headers.get("X-CCH-CSRF")).toBe("csrf-1");
    expect(calls[0].headers.get("X-CCH-CSRF")).toBeNull();
  });

  test("success resolves to ok results", async () => {
    nextResponse = () => json({ settings: { enabled: true } });
    expect(await redactionApi.getOverview()).toEqual({
      ok: true,
      data: { settings: { enabled: true } },
    });
  });

  test("problem responses resolve to error codes", async () => {
    nextResponse = () =>
      json({ errorCode: "INVALID_REGEX", detail: "bad" }, 400, "application/problem+json");
    expect(await redactionApi.createRule({} as never)).toMatchObject({
      ok: false,
      errorCode: "INVALID_REGEX",
    });

    nextResponse = () => json({ errorCode: "auth.forbidden" }, 403, "application/problem+json");
    expect(await redactionApi.getOverview()).toMatchObject({
      ok: false,
      errorCode: "PERMISSION_DENIED",
    });
  });

  test("toErrorCode", () => {
    expect(toErrorCode(new Error("network"))).toBe("UNKNOWN");
    expect(toErrorCode("nope")).toBe("UNKNOWN");
    const csrf = new ApiError({ status: 403, errorCode: "auth.csrf_invalid", detail: "x" });
    expect(toErrorCode(csrf)).toBe("PERMISSION_DENIED");
    const missing = new ApiError({ status: 404, errorCode: "RULE_NOT_FOUND", detail: "x" });
    expect(toErrorCode(missing)).toBe("RULE_NOT_FOUND");
  });

  test("network failures resolve to UNKNOWN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    expect(await redactionApi.getEvents(1)).toEqual({
      ok: false,
      error: "Failed to fetch",
      errorCode: "UNKNOWN",
    });
  });
});
