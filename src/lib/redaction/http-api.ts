/**
 * Fork-only REST surface for the redaction UI, mounted at `/api/fork/redaction` by
 * `src/app/api/fork/redaction/[...route]/route.ts`.
 *
 * Client components may not import server actions (see
 * tests/unit/frontend/no-client-actions-import.test.ts), so the settings page and the usage
 * log call these routes instead. Authentication, CSRF and admin checks reuse the upstream
 * management API middleware; the handlers delegate to `service.ts`.
 * Kept outside the upstream OpenAPI app so syncing upstream never conflicts with it.
 */

import { type Context, Hono } from "hono";
import type { ActionResult } from "@/actions/types";
import { callAction } from "@/lib/api/v1/_shared/action-bridge";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { createProblemResponse } from "@/lib/api/v1/_shared/error-envelope";
import { jsonResponse } from "@/lib/api/v1/_shared/response-helpers";
import { logger } from "@/lib/logger";
import type { RecordsQueryInput } from "./records-query";

export const REDACTION_API_BASE_PATH = "/api/fork/redaction";

const MAX_SUMMARY_IDS = 500;

type ActionModule = typeof import("./service");

function loadActions(): Promise<ActionModule> {
  return import("./service");
}

function statusFor(errorCode: string | undefined): 400 | 403 | 404 | 500 {
  switch (errorCode) {
    case "PERMISSION_DENIED":
      return 403;
    case "RULE_NOT_FOUND":
      return 404;
    case "LOAD_FAILED":
    case "SAVE_FAILED":
    case "PREVIEW_FAILED":
    case "JEV_TEST_FAILED":
      return 500;
    default:
      return 400;
  }
}

function problem(c: Context, status: 400 | 403 | 404 | 500, errorCode: string): Response {
  return createProblemResponse({
    status,
    instance: new URL(c.req.url).pathname,
    errorCode,
    detail: errorCode,
  });
}

async function respond<T>(
  c: Context,
  invoke: (actions: ActionModule) => (...args: never[]) => Promise<ActionResult<T> | T>,
  args: unknown[] = []
): Promise<Response> {
  const actions = await loadActions();
  const result = await callAction<T>(c, invoke(actions), args as never[], c.get("auth"));
  if (!result.ok) return problem(c, statusFor(result.errorCode), result.errorCode ?? "UNKNOWN");
  return jsonResponse(result.data ?? null);
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((part) => parseId(part.trim()))
    .filter((id): id is number => id !== null);
  return [...new Set(ids)].slice(0, MAX_SUMMARY_IDS);
}

function readRecordsQuery(c: Context): RecordsQueryInput {
  return {
    from: c.req.query("from"),
    to: c.req.query("to"),
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
    sessionId: c.req.query("sessionId"),
    filter: c.req.query("filter"),
  };
}

export function createRedactionApp(): Hono {
  const app = new Hono().basePath(REDACTION_API_BASE_PATH);
  const admin = requireAuth("admin");
  const read = requireAuth("read");

  app.get("/overview", admin, (c) => respond(c, (a) => a.getRedactionOverviewAction));

  app.put("/settings", admin, async (c) => {
    const body = await readJson(c);
    if (!body) return problem(c, 400, "request.malformed_json");
    return respond(c, (a) => a.saveRedactionSettingsAction, [body]);
  });

  app.put("/builtin-rules", admin, async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.ruleId !== "string" || typeof body.enabled !== "boolean") {
      return problem(c, 400, "request.validation_failed");
    }
    return respond(c, (a) => a.setBuiltinRuleEnabledAction, [body.ruleId, body.enabled]);
  });

  app.post("/rules", admin, async (c) => {
    const body = await readJson(c);
    if (!body) return problem(c, 400, "request.malformed_json");
    return respond(c, (a) => a.createRedactionRuleAction, [body]);
  });

  app.put("/rules/:id", admin, async (c) => {
    const id = parseId(c.req.param("id"));
    const body = await readJson(c);
    if (!id || !body) return problem(c, 400, "request.validation_failed");
    return respond(c, (a) => a.updateRedactionRuleAction, [id, body]);
  });

  app.put("/rules/:id/status", admin, async (c) => {
    const id = parseId(c.req.param("id"));
    const body = await readJson(c);
    if (!id || !body || typeof body.status !== "string") {
      return problem(c, 400, "request.validation_failed");
    }
    return respond(c, (a) => a.setRedactionRuleStatusAction, [id, body.status]);
  });

  app.delete("/rules/:id", admin, async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return problem(c, 400, "request.validation_failed");
    return respond(c, (a) => a.deleteRedactionRuleAction, [id]);
  });

  app.post("/preview", admin, async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.text !== "string") return problem(c, 400, "request.validation_failed");
    return respond(c, (a) => a.previewRedactionAction, [body.text]);
  });

  app.post("/jev/test", admin, (c) => respond(c, (a) => a.testJevConnectionAction));

  app.delete("/jev/verdicts", admin, (c) => respond(c, (a) => a.clearJevVerdictsAction));

  app.get("/summaries", read, (c) =>
    respond(c, (a) => a.getRedactionSummariesAction, [parseIdList(c.req.query("ids"))])
  );

  app.get("/records/stats", admin, (c) =>
    respond(c, (a) => a.getRedactionRecordStatsAction, [readRecordsQuery(c)])
  );

  app.get("/records/events", admin, (c) =>
    respond(c, (a) => a.listRedactionEventsAction, [readRecordsQuery(c)])
  );

  app.get("/records/jev-calls", admin, (c) =>
    respond(c, (a) => a.listJevCallsAction, [readRecordsQuery(c)])
  );

  app.get("/requests/:id/events", read, (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return problem(c, 400, "request.validation_failed");
    return respond(c, (a) => a.getRedactionEventsAction, [id]);
  });

  app.notFound((c) => problem(c, 404, "not_found"));
  app.onError((error, c) => {
    logger.error("[RedactionApi] Unhandled error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return problem(c, 500, "UNKNOWN");
  });

  return app;
}
