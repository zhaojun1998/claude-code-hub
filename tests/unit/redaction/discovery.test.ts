import { describe, expect, test, vi } from "vitest";
import { extractCandidates } from "@/lib/redaction/candidates";
import { DEFAULT_JEV_SETTINGS } from "@/lib/redaction/config";
import { buildRuleInputs, collectCandidates, RuleDiscovery } from "@/lib/redaction/discovery";
import type { JevCallResult } from "@/lib/redaction/jev-client";
import type { FreshSegment } from "@/lib/redaction/redact-body";
import type { StoredRedactionRule } from "@/lib/redaction/types";

const settings = { ...DEFAULT_JEV_SETTINGS, enabled: true, apiKey: "k" };

function segment(text: string, path = "messages[0].content"): FreshSegment {
  return { path, fingerprint: path, text, matches: [] };
}

function storedRule(id: number, status: StoredRedactionRule["status"]): StoredRedactionRule {
  return {
    id,
    name: "r",
    category: "secret",
    label: "SECRET",
    kind: "literal",
    pattern: "x",
    flags: null,
    groupIndex: null,
    source: "jev",
    status,
    confidence: 0.9,
    description: null,
    hitCount: 0,
    lastHitAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

function makeDeps(answer: (hashes: string[]) => JevCallResult) {
  let nextId = 1;
  return {
    callJev: vi.fn(async (_settings, candidates: Array<{ valueHash: string }>) =>
      answer(candidates.map((candidate) => candidate.valueHash))
    ),
    findCandidateVerdicts: vi.fn(async () => new Set<string>()),
    saveCandidateVerdicts: vi.fn(async () => undefined),
    createStoredRule: vi.fn(async (input: { status: StoredRedactionRule["status"] }) =>
      storedRule(nextId++, input.status)
    ),
    onRulesChanged: vi.fn(async () => undefined),
    onError: vi.fn(),
  };
}

const TEXT =
  "ACME_TOKEN=acme_Q8zR3kD7lM2nP9xW4yV6bT1c\nnote: build 7fGh2Jk9Lm4Np6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef done";

describe("RuleDiscovery", () => {
  test("collectCandidates ranks assignments first and dedupes", () => {
    const candidates = collectCandidates([segment(TEXT), segment(TEXT, "messages[1].content")], 10);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].hint).toBe("assignment");
    expect(collectCandidates([segment(TEXT)], 1)).toHaveLength(1);
  });

  test("buildRuleInputs maps confidence to status and derives a token family pattern", () => {
    const [candidate] = extractCandidates("ACME_TOKEN=acme_Q8zR3kD7lM2nP9xW4yV6bT1c", "p");
    const active = buildRuleInputs(
      candidate,
      { valueHash: candidate.valueHash, category: "secret", confidence: 0.95 },
      settings
    );
    expect(active.map((input) => [input.kind, input.status])).toEqual([
      ["literal", "active"],
      ["regex", "pending"],
    ]);
    expect(active[0].pattern).toBe(candidate.value);
    const pending = buildRuleInputs(
      candidate,
      { valueHash: candidate.valueHash, category: "personal", confidence: 0.7 },
      settings
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", category: "pii", label: "PII" });
    expect(
      buildRuleInputs(
        candidate,
        { valueHash: candidate.valueHash, category: "benign", confidence: 0.99 },
        settings
      )
    ).toEqual([]);
    expect(
      buildRuleInputs(
        candidate,
        { valueHash: candidate.valueHash, category: "internal", confidence: 0.2 },
        settings
      )
    ).toEqual([]);
  });

  test("judges new candidates once and creates rules", async () => {
    const deps = makeDeps((hashes) => ({
      ok: true,
      durationMs: 5,
      model: "jev-1.13.0",
      judgements: [
        { valueHash: hashes[0], category: "secret", confidence: 0.96 },
        { valueHash: hashes[1], category: "benign", confidence: 0.9 },
      ],
    }));
    const discovery = new RuleDiscovery(deps);
    const outcome = await discovery.discover([segment(TEXT)], settings);
    expect(outcome).toMatchObject({
      candidates: 2,
      judged: 2,
      activeRules: 1,
      pendingRules: 1,
      errors: [],
    });
    expect(deps.onRulesChanged).toHaveBeenCalledTimes(1);
    const saved = deps.saveCandidateVerdicts.mock.calls[0][0] as Array<{
      verdict: string;
      ruleId: number | null;
    }>;
    expect(saved.map((row) => row.verdict)).toEqual(["sensitive", "benign"]);
    expect(saved[0].ruleId).toBe(1);

    // Second time: everything is already decided, Jev is not called again.
    const again = await discovery.discover([segment(TEXT)], settings);
    expect(again.candidates).toBe(0);
    expect(deps.callJev).toHaveBeenCalledTimes(1);
  });

  test("skips values with stored verdicts and backs off after failures", async () => {
    let now = 0;
    const deps = makeDeps(() => ({
      ok: false,
      error: "http_500",
      status: 500,
      judgements: [],
      durationMs: 1,
    }));
    const discovery = new RuleDiscovery(deps, () => now);
    const failed = await discovery.discover([segment(TEXT)], settings);
    expect(failed.errors).toEqual(["http_500"]);
    expect(deps.onError).toHaveBeenCalled();
    expect(deps.saveCandidateVerdicts).not.toHaveBeenCalled();
    expect((await discovery.discover([segment(TEXT)], settings)).candidates).toBe(0);
    now = 11 * 60 * 1000;
    await discovery.discover([segment(TEXT)], settings);
    expect(deps.callJev).toHaveBeenCalledTimes(2);

    const known = makeDeps(() => ({ ok: true, judgements: [], durationMs: 1 }));
    known.findCandidateVerdicts.mockImplementation(async (hashes: string[]) => new Set(hashes));
    const fresh = new RuleDiscovery(known);
    expect((await fresh.discover([segment(TEXT)], settings)).candidates).toBe(0);
    expect(known.callJev).not.toHaveBeenCalled();
  });

  test("does nothing when disabled, without key or segments", async () => {
    const deps = makeDeps(() => ({ ok: true, judgements: [], durationMs: 1 }));
    const discovery = new RuleDiscovery(deps);
    expect(
      (await discovery.discover([segment(TEXT)], { ...settings, enabled: false })).candidates
    ).toBe(0);
    expect(
      (await discovery.discover([segment(TEXT)], { ...settings, apiKey: "" })).candidates
    ).toBe(0);
    expect((await discovery.discover([], settings)).candidates).toBe(0);
    expect((await discovery.discover([segment("nothing here")], settings)).candidates).toBe(0);
    expect(deps.callJev).not.toHaveBeenCalled();
  });

  test("reports what happened to every candidate", async () => {
    const deps = makeDeps((hashes) => ({
      ok: true,
      durationMs: 3,
      model: "jev-1.13.0",
      inputTokens: 120,
      judgements: [
        { valueHash: hashes[0], category: "secret", confidence: 0.96 },
        // A repeated judgement for the same candidate is ignored.
        { valueHash: hashes[0], category: "benign", confidence: 0.9 },
        { valueHash: "unknown", category: "secret", confidence: 0.9 },
      ],
    }));
    const outcome = await new RuleDiscovery(deps).discover([segment(TEXT)], settings);
    expect(outcome).toMatchObject({ judged: 1, model: "jev-1.13.0", inputTokens: 120 });
    expect(outcome.results.map((r) => [r.candidate.hint, r.outcome, r.ruleIds])).toEqual([
      ["assignment", "active", [1, 2]],
      ["high_entropy", "unjudged", []],
    ]);
    expect(outcome.results[0]).toMatchObject({ category: "secret", confidence: 0.96 });
    expect(outcome.results[1]).toMatchObject({ category: null, confidence: null });
  });

  test("outcomes for pending, low-confidence, benign, existing and failed candidates", async () => {
    const outcomesFor = async (answer: (hashes: string[]) => JevCallResult) => {
      const deps = makeDeps(answer);
      const outcome = await new RuleDiscovery(deps).discover([segment(TEXT)], settings);
      return outcome.results.map((result) => result.outcome);
    };

    expect(
      await outcomesFor((hashes) => ({
        ok: true,
        durationMs: 1,
        judgements: [
          { valueHash: hashes[0], category: "personal", confidence: 0.7 },
          { valueHash: hashes[1], category: "internal", confidence: 0.2 },
        ],
      }))
    ).toEqual(["pending", "low_confidence"]);

    expect(
      await outcomesFor((hashes) => ({
        ok: true,
        durationMs: 1,
        judgements: [{ valueHash: hashes[0], category: "benign", confidence: 0.99 }],
      }))
    ).toEqual(["benign", "unjudged"]);

    const existing = makeDeps((hashes) => ({
      ok: true,
      durationMs: 1,
      judgements: [{ valueHash: hashes[0], category: "secret", confidence: 0.99 }],
    }));
    existing.createStoredRule.mockResolvedValue(null as unknown as StoredRedactionRule);
    const existingOutcome = await new RuleDiscovery(existing).discover([segment(TEXT)], settings);
    expect(existingOutcome.results[0]).toMatchObject({ outcome: "existing", ruleIds: [] });

    const failing = makeDeps(() => ({
      ok: false,
      error: "timeout",
      judgements: [],
      durationMs: 1,
    }));
    const failed = await new RuleDiscovery(failing).discover([segment(TEXT)], settings);
    expect(failed.results.map((result) => result.outcome)).toEqual(["failed", "failed"]);
    expect(failed).toMatchObject({ model: null, inputTokens: 0, errors: ["timeout"] });
  });

  test("duplicate rules are not counted", async () => {
    const deps = makeDeps((hashes) => ({
      ok: true,
      durationMs: 1,
      judgements: [{ valueHash: hashes[0], category: "secret", confidence: 0.99 }],
    }));
    deps.createStoredRule.mockResolvedValue(null as unknown as StoredRedactionRule);
    const outcome = await new RuleDiscovery(deps).discover([segment(TEXT)], settings);
    expect(outcome.activeRules).toBe(0);
    expect(deps.onRulesChanged).not.toHaveBeenCalled();
  });
});
