/**
 * Jev-based rule discovery.
 *
 * New strings in a request are scanned locally for candidates (see `candidates.ts`). Each
 * candidate value is judged at most once: verdicts are cached in memory and in the
 * `fork_redaction_candidates` table by value hash. Judgements at or above
 * `autoEnableThreshold` become active literal rules immediately; judgements between
 * `suggestThreshold` and `autoEnableThreshold` become pending rules for review. Vendor-style
 * prefixed tokens additionally yield a pending regex rule that matches the whole token family.
 */

import {
  type DiscoveryCandidate,
  deriveTokenPattern,
  extractCandidates,
  maskValue,
} from "./candidates";
import type { JevCallResult, JevCategory, JevJudgement } from "./jev-client";
import { JEV_MAX_CANDIDATES_PER_CALL } from "./jev-client";
import type { FreshSegment } from "./redact-body";
import type { CandidateVerdictRow, RuleInput } from "./store";
import type { JevSettings, RedactionCategory, StoredRedactionRule } from "./types";

export interface DiscoveryDeps {
  callJev(settings: JevSettings, candidates: DiscoveryCandidate[]): Promise<JevCallResult>;
  findCandidateVerdicts(hashes: string[]): Promise<Set<string>>;
  saveCandidateVerdicts(rows: CandidateVerdictRow[]): Promise<void>;
  createStoredRule(input: RuleInput): Promise<StoredRedactionRule | null>;
  onRulesChanged(): Promise<void>;
  onError?(message: string, detail: Record<string, unknown>): void;
}

export interface DiscoveryOutcome {
  candidates: number;
  judged: number;
  activeRules: number;
  pendingRules: number;
  errors: string[];
}

const CATEGORY_MAP: Record<
  Exclude<JevCategory, "benign">,
  { category: RedactionCategory; label: string }
> = {
  secret: { category: "secret", label: "SECRET" },
  personal: { category: "pii", label: "PII" },
  internal: { category: "network", label: "INTERNAL" },
};

const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const DECIDED_CAPACITY = 50_000;

export function collectCandidates(segments: FreshSegment[], limit: number): DiscoveryCandidate[] {
  const byHash = new Map<string, DiscoveryCandidate>();
  for (const segment of segments) {
    for (const candidate of extractCandidates(segment.text, segment.path, segment.matches)) {
      if (!byHash.has(candidate.valueHash)) byHash.set(candidate.valueHash, candidate);
    }
  }
  // Prefer candidates with the strongest signal: explicit assignments and URL passwords first.
  const ranked = [...byHash.values()].sort((a, b) => rank(a) - rank(b));
  return ranked.slice(0, Math.max(0, limit));
}

function rank(candidate: DiscoveryCandidate): number {
  switch (candidate.hint) {
    case "url_credential":
      return 0;
    case "assignment":
      return 1;
    default:
      return 2;
  }
}

export function buildRuleInputs(
  candidate: DiscoveryCandidate,
  judgement: JevJudgement,
  settings: Pick<JevSettings, "autoEnableThreshold" | "suggestThreshold">
): RuleInput[] {
  if (judgement.category === "benign" || judgement.confidence < settings.suggestThreshold)
    return [];
  const mapping = CATEGORY_MAP[judgement.category];
  const status = judgement.confidence >= settings.autoEnableThreshold ? "active" : "pending";
  const confidence = Math.round(judgement.confidence * 1000) / 1000;
  const context = candidate.keyName ? ` (${candidate.keyName})` : "";
  const inputs: RuleInput[] = [
    {
      name: `Jev ${judgement.category}: ${maskValue(candidate.value)}${context}`.slice(0, 128),
      category: mapping.category,
      label: mapping.label,
      kind: "literal",
      pattern: candidate.value,
      source: "jev",
      status,
      confidence,
      description: `${candidate.hint} at ${candidate.path}`.slice(0, 500),
      valueHash: candidate.valueHash,
    },
  ];
  if (judgement.category === "secret") {
    const pattern = deriveTokenPattern(candidate.value);
    if (pattern) {
      inputs.push({
        name: `Jev token family: ${candidate.value.slice(0, candidate.value.search(/[_-]/) + 1)}*`.slice(
          0,
          128
        ),
        category: "secret",
        label: "TOKEN",
        kind: "regex",
        pattern,
        source: "jev",
        // A generalized pattern always needs review, even at high confidence.
        status: "pending",
        confidence,
        description: `Derived from a ${maskValue(candidate.value)} token`,
        valueHash: `pattern:${pattern.length}:${candidate.valueHash.slice(0, 16)}`,
      });
    }
  }
  return inputs;
}

export class RuleDiscovery {
  private readonly decided = new Map<string, number>();
  private readonly inflight = new Set<string>();

  constructor(
    private readonly deps: DiscoveryDeps,
    private readonly now: () => number = Date.now
  ) {}

  private isDecided(hash: string): boolean {
    const until = this.decided.get(hash);
    if (until === undefined) return false;
    if (until !== Number.POSITIVE_INFINITY && until <= this.now()) {
      this.decided.delete(hash);
      return false;
    }
    return true;
  }

  private markDecided(hash: string, until = Number.POSITIVE_INFINITY): void {
    if (this.decided.size >= DECIDED_CAPACITY) {
      const oldest = this.decided.keys().next().value;
      if (oldest !== undefined) this.decided.delete(oldest);
    }
    this.decided.set(hash, until);
  }

  async discover(segments: FreshSegment[], settings: JevSettings): Promise<DiscoveryOutcome> {
    const outcome: DiscoveryOutcome = {
      candidates: 0,
      judged: 0,
      activeRules: 0,
      pendingRules: 0,
      errors: [],
    };
    if (!settings.enabled || !settings.apiKey || segments.length === 0) return outcome;

    const all = collectCandidates(segments, Number.POSITIVE_INFINITY).filter(
      (candidate) => !this.isDecided(candidate.valueHash) && !this.inflight.has(candidate.valueHash)
    );
    if (all.length === 0) return outcome;

    const known = await this.deps.findCandidateVerdicts(all.map((c) => c.valueHash));
    for (const hash of known) this.markDecided(hash);
    const pending = all
      .filter((candidate) => !known.has(candidate.valueHash))
      .slice(0, settings.maxCandidatesPerRequest);
    outcome.candidates = pending.length;
    if (pending.length === 0) return outcome;

    for (const candidate of pending) this.inflight.add(candidate.valueHash);
    try {
      const chunks: DiscoveryCandidate[][] = [];
      for (let i = 0; i < pending.length; i += JEV_MAX_CANDIDATES_PER_CALL) {
        chunks.push(pending.slice(i, i + JEV_MAX_CANDIDATES_PER_CALL));
      }
      const results = await Promise.all(chunks.map((chunk) => this.judgeChunk(chunk, settings)));
      let rulesChanged = false;
      for (const result of results) {
        outcome.judged += result.judged;
        outcome.activeRules += result.activeRules;
        outcome.pendingRules += result.pendingRules;
        if (result.error) outcome.errors.push(result.error);
        rulesChanged ||= result.activeRules > 0;
      }
      if (rulesChanged) await this.deps.onRulesChanged();
    } finally {
      for (const candidate of pending) this.inflight.delete(candidate.valueHash);
    }
    return outcome;
  }

  private async judgeChunk(chunk: DiscoveryCandidate[], settings: JevSettings) {
    const summary = {
      judged: 0,
      activeRules: 0,
      pendingRules: 0,
      error: undefined as string | undefined,
    };
    const result = await this.deps.callJev(settings, chunk);
    if (!result.ok) {
      summary.error = result.error ?? "jev_failed";
      for (const candidate of chunk) {
        this.markDecided(candidate.valueHash, this.now() + FAILURE_BACKOFF_MS);
      }
      this.deps.onError?.("[Redaction] Jev discovery call failed", {
        error: summary.error,
        status: result.status,
        candidates: chunk.length,
      });
      return summary;
    }

    const byHash = new Map(chunk.map((candidate) => [candidate.valueHash, candidate]));
    const verdicts: CandidateVerdictRow[] = [];
    for (const judgement of result.judgements) {
      const candidate = byHash.get(judgement.valueHash);
      if (!candidate) continue;
      summary.judged++;
      let ruleId: number | null = null;
      const inputs = buildRuleInputs(candidate, judgement, settings);
      for (const input of inputs) {
        const created = await this.deps.createStoredRule(input);
        if (!created) continue;
        if (input.kind === "literal") ruleId = created.id;
        if (created.status === "active") summary.activeRules++;
        else summary.pendingRules++;
      }
      verdicts.push({
        valueHash: candidate.valueHash,
        verdict: inputs.length > 0 ? "sensitive" : "benign",
        category: judgement.category,
        confidence: judgement.confidence,
        hint: candidate.hint,
        preview: maskValue(candidate.value).slice(0, 64),
        ruleId,
        model: result.model ?? settings.model,
      });
      this.markDecided(candidate.valueHash);
    }
    await this.deps.saveCandidateVerdicts(verdicts);
    return summary;
  }
}
