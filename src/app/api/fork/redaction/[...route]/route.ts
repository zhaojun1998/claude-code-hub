import "@/lib/auth-session-storage.node";
import { handle } from "hono/vercel";
import { withManagementSecurityHeaders } from "@/lib/api/v1/_shared/management-security-headers";
import { createRedactionApp } from "@/lib/redaction/http-api";

// [fork:redaction] REST routes for the redaction settings page and usage log badges.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = handle(createRedactionApp());

async function handleRedactionRequest(request: Request): Promise<Response> {
  return withManagementSecurityHeaders(await handler(request));
}

export const GET = handleRedactionRequest;
export const POST = handleRedactionRequest;
export const PUT = handleRedactionRequest;
export const DELETE = handleRedactionRequest;
