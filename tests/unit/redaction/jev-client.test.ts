import { describe, expect, test, vi } from "vitest";
import { extractCandidates } from "@/lib/redaction/candidates";
import { DEFAULT_JEV_SETTINGS } from "@/lib/redaction/config";
import {
  buildJevPayload,
  callJev,
  JEV_MAX_REQUEST_BYTES,
  maskContext,
  parseJevAnswers,
  resolveJevEndpoint,
} from "@/lib/redaction/jev-client";

const candidates = extractCandidates(
  "STRIPE_SECRET=sk_live_" + "8fK2mQ9vL4pX7rT1wZ3yB6nC and db_password=Hx7#kP2$mQ9vR4tW",
  "messages[0].content"
);
const settings = { ...DEFAULT_JEV_SETTINGS, enabled: true, apiKey: "jev-key" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Jev client", () => {
  test("endpoints", () => {
    expect(
      resolveJevEndpoint({ provider: "typesafe", baseUrl: "https://api.typesafe.ai/v1/" })
    ).toBe("https://api.typesafe.ai/v1/systemone");
    expect(resolveJevEndpoint({ provider: "openrouter", baseUrl: "" })).toBe(
      "https://openrouter.ai/api/v1/alpha/decisions"
    );
  });

  test("masked payload carries only the shape; full payload carries the value", () => {
    expect(candidates).toHaveLength(2);
    const masked = buildJevPayload(candidates, settings);
    const body = JSON.parse(masked.body);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["c1", "c2"]);
    expect(body.questions.c1.type).toBe("choice");
    expect(Object.keys(body.questions.c1.criteria)).toEqual([
      "secret",
      "personal",
      "internal",
      "benign",
    ]);
    expect(masked.body).not.toContain("8fK2mQ9vL4pX7rT1wZ3yB6nC");
    expect(body.state.candidates[0].shape).toBeTruthy();
    expect(body.state.candidates[0].key).toBe("STRIPE_SECRET");

    const full = buildJevPayload(candidates, { ...settings, sendMode: "full" });
    expect(full.body).toContain("sk_live_" + "8fK2mQ9vL4pX7rT1wZ3yB6nC");
  });

  test("masked contexts hide other candidate-like values", () => {
    const blob = "Tr4ceBl0bQ7wE9rT2yU5iO8pA1sD3fG6h";
    expect(maskContext(`see ${blob} and abc123def456 here`, [])).toBe(
      "see [MASKED] and abc123def456 here"
    );
    expect(maskContext("known value-one and more", ["value-one"])).toBe("known [MASKED] and more");
    expect(maskContext("plain words only", [])).toBe("plain words only");
  });

  test("oversized contexts are trimmed", () => {
    const big = Array.from({ length: 16 }, (_, index) => ({
      ...candidates[0],
      valueHash: `h${index}`,
      contextBefore: "x".repeat(6000),
      contextAfter: "",
    }));
    const { body } = buildJevPayload(big, settings);
    expect(body.length).toBeLessThan(JEV_MAX_REQUEST_BYTES);
  });

  test("parseJevAnswers validates each answer", () => {
    const { ids } = buildJevPayload(candidates, settings);
    expect(parseJevAnswers(null, ids)).toBeNull();
    expect(parseJevAnswers({}, ids)).toBeNull();
    const judgements = parseJevAnswers(
      {
        answers: {
          c1: { type: "choice", choice: "secret", confidence: 0.97 },
          c2: { type: "choice", choice: "nonsense", confidence: 0.5 },
        },
      },
      ids
    );
    expect(judgements).toEqual([
      { valueHash: candidates[0].valueHash, category: "secret", confidence: 0.97 },
    ]);
    expect(
      parseJevAnswers({ answers: { c1: { choice: "secret", confidence: "2" }, c2: "x" } }, ids)
    ).toEqual([]);
  });

  test("callJev success", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jev-key");
      return jsonResponse({
        model: "jev-1.13.0",
        answers: {
          c1: { choice: "secret", confidence: 0.95 },
          c2: { choice: "benign", confidence: 0.8 },
        },
        usage: { input_tokens: 321 },
      });
    });
    const result = await callJev(settings, candidates, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(321);
    expect(result.judgements.map((j) => j.category)).toEqual(["secret", "benign"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.anything()
    );
  });

  test("callJev failures", async () => {
    expect((await callJev({ ...settings, apiKey: "" }, candidates)).error).toBe("missing_api_key");
    expect((await callJev(settings, [])).ok).toBe(true);
    expect(
      (await callJev(settings, candidates, { fetchImpl: async () => jsonResponse({}, 401) })).error
    ).toBe("http_401");
    expect(
      (
        await callJev(settings, candidates, {
          fetchImpl: async () => new Response("not json", { status: 200 }),
        })
      ).error
    ).toBe("invalid_json");
    expect(
      (await callJev(settings, candidates, { fetchImpl: async () => jsonResponse({ nope: 1 }) }))
        .error
    ).toBe("invalid_response");
    expect(
      (
        await callJev(settings, candidates, {
          fetchImpl: async () => {
            throw new Error("ECONNRESET");
          },
        })
      ).error
    ).toBe("ECONNRESET");
    const timedOut = await callJev(settings, candidates, {
      hardTimeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect(timedOut.error).toBe("timeout");
  });
});
