import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

const actions = vi.hoisted(() => ({
  getRedactionOverviewAction: vi.fn(),
  saveRedactionSettingsAction: vi.fn(),
  setBuiltinRuleEnabledAction: vi.fn(),
  createRedactionRuleAction: vi.fn(),
  updateRedactionRuleAction: vi.fn(),
  setRedactionRuleStatusAction: vi.fn(),
  deleteRedactionRuleAction: vi.fn(),
  previewRedactionAction: vi.fn(),
  testJevConnectionAction: vi.fn(),
  clearJevVerdictsAction: vi.fn(),
  getRedactionSummariesAction: vi.fn(),
  getRedactionEventsAction: vi.fn(),
}));

vi.mock("@/lib/redaction/service", () => actions);
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The test role travels in a header: "admin", "user" or absent (anonymous).
vi.mock("@/lib/api/v1/_shared/auth-middleware", () => ({
  requireAuth:
    (tier: "read" | "admin"): MiddlewareHandler =>
    async (c, next) => {
      const role = c.req.header("x-test-role");
      if (!role) return c.json({ errorCode: "auth.missing" }, 401);
      if (tier === "admin" && role !== "admin") {
        return c.json({ errorCode: "auth.forbidden" }, 403);
      }
      c.set("auth", { session: null, role });
      await next();
    },
}));

vi.mock("@/lib/api/v1/_shared/action-bridge", () => ({
  callAction: async (_c: unknown, action: (...args: unknown[]) => unknown, args: unknown[]) =>
    action(...args),
}));

import { createRedactionApp, parseIdList } from "@/lib/redaction/http-api";

const app = createRedactionApp();
const BASE = "http://localhost/api/fork/redaction";

function request(
  method: string,
  path: string,
  options: { body?: unknown; raw?: string; role?: string | null } = {}
) {
  const headers: Record<string, string> = {};
  const role = options.role === undefined ? "admin" : options.role;
  if (role) headers["x-test-role"] = role;
  let body: string | undefined;
  if (options.raw !== undefined) body = options.raw;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${BASE}${path}`, { method, headers, body });
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockResolvedValue({ ok: true, data: { done: true } });
});

describe("redaction REST app", () => {
  test("parseIdList keeps unique positive integers", () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList("3, 1,x,3,-2,0,4.5")).toEqual([3, 1]);
    const many = Array.from({ length: 600 }, (_, index) => index + 1).join(",");
    expect(parseIdList(many)).toHaveLength(500);
  });

  test("overview returns the action data", async () => {
    const response = await request("GET", "/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });
    expect(actions.getRedactionOverviewAction).toHaveBeenCalledWith();
  });

  test("admin routes reject anonymous and non-admin callers", async () => {
    expect((await request("GET", "/overview", { role: null })).status).toBe(401);
    expect((await request("GET", "/overview", { role: "user" })).status).toBe(403);
    expect((await request("POST", "/preview", { body: { text: "x" }, role: "user" })).status).toBe(
      403
    );
    expect(actions.getRedactionOverviewAction).not.toHaveBeenCalled();
  });

  test("read routes are open to signed-in users", async () => {
    const summaries = await request("GET", "/summaries?ids=5,2,5", { role: "user" });
    expect(summaries.status).toBe(200);
    expect(actions.getRedactionSummariesAction).toHaveBeenCalledWith([5, 2]);

    const events = await request("GET", "/requests/9/events", { role: "user" });
    expect(events.status).toBe(200);
    expect(actions.getRedactionEventsAction).toHaveBeenCalledWith(9);

    expect((await request("GET", "/requests/abc/events", { role: "user" })).status).toBe(400);
    expect((await request("GET", "/summaries", { role: null })).status).toBe(401);
  });

  test("settings and built-in toggles validate their bodies", async () => {
    expect((await request("PUT", "/settings", { raw: "{oops" })).status).toBe(400);
    expect((await request("PUT", "/settings", { body: [1, 2] })).status).toBe(400);
    expect((await request("PUT", "/settings", { body: { enabled: true } })).status).toBe(200);
    expect(actions.saveRedactionSettingsAction).toHaveBeenCalledWith({ enabled: true });

    expect((await request("PUT", "/builtin-rules", { body: { ruleId: "x" } })).status).toBe(400);
    const toggled = await request("PUT", "/builtin-rules", {
      body: { ruleId: "builtin:email", enabled: true },
    });
    expect(toggled.status).toBe(200);
    expect(actions.setBuiltinRuleEnabledAction).toHaveBeenCalledWith("builtin:email", true);
  });

  test("rule routes pass ids and bodies through", async () => {
    const form = { name: "Acme", kind: "literal", pattern: "acme-secret" };
    expect((await request("POST", "/rules", { raw: "nope" })).status).toBe(400);
    expect((await request("POST", "/rules", { body: form })).status).toBe(200);
    expect(actions.createRedactionRuleAction).toHaveBeenCalledWith(form);

    expect((await request("PUT", "/rules/0", { body: form })).status).toBe(400);
    expect((await request("PUT", "/rules/7", { body: form })).status).toBe(200);
    expect(actions.updateRedactionRuleAction).toHaveBeenCalledWith(7, form);

    expect((await request("PUT", "/rules/7/status", { body: {} })).status).toBe(400);
    expect((await request("PUT", "/rules/7/status", { body: { status: "active" } })).status).toBe(
      200
    );
    expect(actions.setRedactionRuleStatusAction).toHaveBeenCalledWith(7, "active");

    expect((await request("DELETE", "/rules/x")).status).toBe(400);
    actions.deleteRedactionRuleAction.mockResolvedValue({ ok: true });
    const deleted = await request("DELETE", "/rules/7");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toBeNull();
    expect(actions.deleteRedactionRuleAction).toHaveBeenCalledWith(7);
  });

  test("preview and Jev routes", async () => {
    expect((await request("POST", "/preview", { body: {} })).status).toBe(400);
    expect((await request("POST", "/preview", { body: { text: "hello" } })).status).toBe(200);
    expect(actions.previewRedactionAction).toHaveBeenCalledWith("hello");

    expect((await request("POST", "/jev/test")).status).toBe(200);
    expect(actions.testJevConnectionAction).toHaveBeenCalled();
    expect((await request("DELETE", "/jev/verdicts")).status).toBe(200);
    expect(actions.clearJevVerdictsAction).toHaveBeenCalled();
  });

  test.each([
    ["PERMISSION_DENIED", 403],
    ["RULE_NOT_FOUND", 404],
    ["SAVE_FAILED", 500],
    ["LOAD_FAILED", 500],
    ["INVALID_REGEX", 400],
    [undefined, 400],
  ])("action error %s maps to HTTP %i", async (errorCode, status) => {
    actions.getRedactionOverviewAction.mockResolvedValue({ ok: false, error: "x", errorCode });
    const response = await request("GET", "/overview");
    expect(response.status).toBe(status);
    expect((await response.json()).errorCode).toBe(errorCode ?? "UNKNOWN");
  });

  test("Next route handlers serve the app with management security headers", async () => {
    const route = await import("@/app/api/fork/redaction/[...route]/route");
    expect(route.runtime).toBe("nodejs");
    for (const handler of [route.GET, route.POST, route.PUT, route.DELETE]) {
      expect(handler).toBe(route.GET);
    }
    const response = await route.GET(
      new Request(`${BASE}/overview`, { headers: { "x-test-role": "admin" } })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ done: true });
  });

  test("unknown routes and thrown errors become problem responses", async () => {
    const missing = await request("GET", "/nothing-here");
    expect(missing.status).toBe(404);
    expect((await missing.json()).errorCode).toBe("not_found");

    actions.getRedactionOverviewAction.mockRejectedValue(new Error("boom"));
    const failed = await request("GET", "/overview");
    expect(failed.status).toBe(500);
    expect((await failed.json()).errorCode).toBe("UNKNOWN");
  });
});
