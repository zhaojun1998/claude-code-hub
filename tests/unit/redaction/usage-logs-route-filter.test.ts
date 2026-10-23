import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthSession } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  validateAuthToken: vi.fn(),
  getUsageLogsBatch: vi.fn(),
  getUsageLogsStats: vi.fn(),
  exportUsageLogs: vi.fn(),
  startUsageLogsExport: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, validateAuthToken: mocks.validateAuthToken };
});

vi.mock("@/actions/usage-logs", () => ({
  getUsageLogs: vi.fn(),
  getUsageLogsBatch: mocks.getUsageLogsBatch,
  getUsageLogsStats: mocks.getUsageLogsStats,
  getFilterOptions: vi.fn(),
  getModelList: vi.fn(),
  getStatusCodeList: vi.fn(),
  getEndpointList: vi.fn(),
  getUsageLogSessionIdSuggestions: vi.fn(),
  exportUsageLogs: mocks.exportUsageLogs,
  startUsageLogsExport: mocks.startUsageLogsExport,
  getUsageLogsExportStatus: vi.fn(),
  downloadUsageLogsExport: vi.fn(),
}));

vi.mock("@/lib/api-client/v1/client", () => ({
  apiClient: { get: vi.fn(), post: mocks.apiPost, patch: vi.fn(), delete: vi.fn() },
}));

const { callV1Route } = await import("../../api/v1/test-utils");
// tests/setup.ts maps the browser API client onto the server actions; test the real module.
const clientActions = await vi.importActual<
  typeof import("@/lib/api-client/v1/actions/usage-logs")
>("@/lib/api-client/v1/actions/usage-logs");

const adminSession = {
  user: { id: 1, role: "admin", isEnabled: true },
  key: { id: 1, userId: 1, key: "admin-token", canLoginWebUi: true },
} as AuthSession;

const headers = { Authorization: "Bearer admin-token" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateAuthToken.mockResolvedValue(adminSession);
  mocks.getUsageLogsBatch.mockResolvedValue({
    ok: true,
    data: { logs: [], nextCursor: null, hasMore: false },
  });
  mocks.getUsageLogsStats.mockResolvedValue({ ok: true, data: { totalRequests: 0 } });
  mocks.exportUsageLogs.mockResolvedValue({ ok: true, data: "Time\n" });
  mocks.startUsageLogsExport.mockResolvedValue({ ok: true, data: { jobId: "job-1" } });
  mocks.apiPost.mockResolvedValue({ csv: "Time\n" });
});

describe("usage log routes: triggered redaction filter", () => {
  test("list and stats read redactedOnly from the query", async () => {
    const list = await callV1Route({
      method: "GET",
      pathname: "/api/v1/usage-logs?limit=10&redactedOnly=true",
      headers,
    });
    expect(list.response.status).toBe(200);
    expect(mocks.getUsageLogsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ redactedOnly: true, limit: 10 })
    );

    const stats = await callV1Route({
      method: "GET",
      pathname: "/api/v1/usage-logs/stats?redactedOnly=1",
      headers,
    });
    expect(stats.response.status).toBe(200);
    expect(mocks.getUsageLogsStats).toHaveBeenCalledWith(
      expect.objectContaining({ redactedOnly: true })
    );

    await callV1Route({ method: "GET", pathname: "/api/v1/usage-logs?limit=10", headers });
    expect(mocks.getUsageLogsBatch.mock.calls.at(-1)?.[0]).not.toHaveProperty("redactedOnly");
  });

  test("exports take the flag from the query string, not the strict body", async () => {
    const sync = await callV1Route({
      method: "POST",
      pathname: "/api/v1/usage-logs/exports?redactedOnly=true",
      headers,
      body: { model: "claude" },
    });
    expect(sync.response.status).toBe(200);
    expect(mocks.exportUsageLogs).toHaveBeenCalledWith({
      model: "claude",
      format: "csv",
      redactedOnly: true,
    });

    const queued = await callV1Route({
      method: "POST",
      pathname: "/api/v1/usage-logs/exports?redactedOnly=true",
      headers: { ...headers, Prefer: "respond-async" },
      body: {},
    });
    expect(queued.response.status).toBe(202);
    expect(mocks.startUsageLogsExport).toHaveBeenCalledWith({ format: "csv", redactedOnly: true });

    // The body schema stays strict: the flag is not accepted there.
    const rejected = await callV1Route({
      method: "POST",
      pathname: "/api/v1/usage-logs/exports",
      headers,
      body: { redactedOnly: true },
    });
    expect(rejected.response.status).toBe(400);
  });

  test("the browser client moves the flag into the export URL", async () => {
    const lastPost = () => mocks.apiPost.mock.calls.at(-1)?.slice(0, 2);

    await clientActions.exportUsageLogs({ model: "claude", redactedOnly: true });
    expect(lastPost()).toEqual([
      "/api/v1/usage-logs/exports?redactedOnly=true",
      { model: "claude" },
    ]);

    await clientActions.startUsageLogsExport({ format: "csv", redactedOnly: true });
    expect(lastPost()).toEqual(["/api/v1/usage-logs/exports?redactedOnly=true", { format: "csv" }]);

    await clientActions.exportUsageLogs({ model: "claude" });
    expect(lastPost()).toEqual(["/api/v1/usage-logs/exports", { model: "claude" }]);
  });
});
