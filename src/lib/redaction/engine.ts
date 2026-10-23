import { createHash, createHmac } from "node:crypto";
import type {
  RedactionRuleDefinition,
  RedactionValidator,
  TextMatch,
  TextRedaction,
} from "./types";
import {
  hasLettersAndDigits,
  isCredentialValue,
  isJwt,
  isNotReservedIpv4,
  isPlausibleChinesePhone,
  isPlausibleEmail,
  isValidChineseId,
  isValidIban,
  isValidUscc,
  looksLikePlaceholder,
  looksReal,
  passesLuhn,
  shannonEntropy,
} from "./validators";

export const DEFAULT_PLACEHOLDER_TEMPLATE = "[REDACTED:{label}#{hash}]";

const MAX_MATCHES_PER_RULE = 10_000;
const MIN_LITERAL_LENGTH = 4;

interface CompiledRegexRule {
  index: number;
  def: RedactionRuleDefinition;
  regex: RegExp;
  keywords: string[] | null;
}

export interface RedactionEngineOptions {
  placeholderTemplate?: string;
  /** Secret salt for placeholder hashes, so short values cannot be brute-forced from the hash. */
  salt: string;
  /** Exact values (case-insensitive) that are never redacted. */
  allowlist?: readonly string[];
}

export interface RuleCompileIssue {
  ruleId: string;
  error: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function normalizeFlags(flags: string | undefined): string {
  const allowed = new Set(["i", "m", "s", "u"]);
  const unique = new Set<string>();
  for (const flag of flags ?? "") {
    if (allowed.has(flag)) unique.add(flag);
  }
  return [...unique].join("");
}

/** Compiles one regex rule; returns an error message instead of throwing. */
export function compileRuleRegex(
  def: Pick<RedactionRuleDefinition, "pattern" | "flags">
): RegExp | string {
  try {
    return new RegExp(def.pattern, `${normalizeFlags(def.flags)}gd`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Returns true when a regex accepts the empty string or covers most of ordinary prose. */
export function isBroadPattern(regex: RegExp): boolean {
  const probe = new RegExp(regex.source, regex.flags.replace("g", ""));
  if (probe.test("")) return true;
  const samples = [
    "A normal message with several words.",
    "这是一段普通的请求内容。",
    "alpha 123\nbeta 456",
  ];
  let covered = 0;
  for (const sample of samples) {
    const global = new RegExp(regex.source, regex.flags);
    let length = 0;
    for (const match of sample.matchAll(global)) {
      length += match[0].length;
    }
    if (length * 10 >= sample.length * 8) covered++;
  }
  return covered >= 2;
}

function placeholderPattern(template: string): RegExp {
  const parts = template.split(/(\{label\}|\{hash\})/);
  const source = parts
    .map((part) => {
      if (part === "{label}") return "[A-Z0-9_]{1,48}";
      if (part === "{hash}") return "[0-9a-f]{6,16}";
      return escapeRegex(part);
    })
    .join("");
  return new RegExp(source, "g");
}

const VALIDATORS: Record<RedactionValidator, (text: string, minEntropy?: number) => boolean> = {
  luhn: passesLuhn,
  cn_id: isValidChineseId,
  cn_phone: isPlausibleChinesePhone,
  cn_uscc: isValidUscc,
  iban: isValidIban,
  entropy: (text, minEntropy) => shannonEntropy(text) >= (minEntropy ?? 3.5),
  not_placeholder: (text) => !looksLikePlaceholder(text),
  looks_real: looksReal,
  mixed_alnum: hasLettersAndDigits,
  credential: (text, minEntropy) => isCredentialValue(text, minEntropy ?? 3),
  jwt: isJwt,
  email: isPlausibleEmail,
  ipv4_public: isNotReservedIpv4,
};

export function passesValidators(
  text: string,
  validators: RedactionValidator[] | undefined,
  minEntropy: number | undefined
): boolean {
  if (!validators || validators.length === 0) return true;
  return validators.every((name) => VALIDATORS[name]?.(text, minEntropy) ?? true);
}

/**
 * Compiled rule set. Matching is deterministic: the same text and rules always yield the
 * same placeholders, which keeps upstream prompt-cache prefixes stable across requests.
 */
export class RedactionEngine {
  readonly version: string;
  readonly rules: readonly RedactionRuleDefinition[];
  readonly issues: RuleCompileIssue[] = [];
  private readonly regexRules: CompiledRegexRule[] = [];
  private readonly literalRegex: RegExp | null = null;
  private readonly literalRuleIndex = new Map<string, number>();
  private readonly template: string;
  private readonly salt: string;
  private readonly placeholderRegex: RegExp;
  private readonly hashCache = new Map<string, string>();
  private readonly allowlist: Set<string>;

  constructor(rules: RedactionRuleDefinition[], options: RedactionEngineOptions) {
    this.rules = rules;
    this.template = options.placeholderTemplate?.includes("{hash}")
      ? options.placeholderTemplate
      : DEFAULT_PLACEHOLDER_TEMPLATE;
    this.salt = options.salt;
    this.allowlist = new Set(
      (options.allowlist ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    );
    this.placeholderRegex = placeholderPattern(this.template);

    const literals: string[] = [];
    rules.forEach((def, index) => {
      if (def.kind === "literal") {
        const literal = def.pattern;
        if (literal.length < MIN_LITERAL_LENGTH) {
          this.issues.push({ ruleId: def.id, error: "literal_too_short" });
          return;
        }
        if (!this.literalRuleIndex.has(literal)) {
          this.literalRuleIndex.set(literal, index);
          literals.push(literal);
        }
        return;
      }
      const compiled = compileRuleRegex(def);
      if (typeof compiled === "string") {
        this.issues.push({ ruleId: def.id, error: compiled });
        return;
      }
      const keywords =
        def.keywords && def.keywords.length > 0 ? def.keywords.map((k) => k.toLowerCase()) : null;
      this.regexRules.push({ index, def, regex: compiled, keywords });
    });

    if (literals.length > 0) {
      literals.sort((a, b) => b.length - a.length);
      this.literalRegex = new RegExp(literals.map(escapeRegex).join("|"), "g");
    }

    this.version = createHash("sha256")
      .update(JSON.stringify({ rules, template: this.template, allow: [...this.allowlist] }))
      .update(this.salt)
      .digest("hex")
      .slice(0, 16);
  }

  private isAllowed(text: string): boolean {
    return this.allowlist.size > 0 && this.allowlist.has(text.trim().toLowerCase());
  }

  get isEmpty(): boolean {
    return this.regexRules.length === 0 && this.literalRegex === null;
  }

  placeholderFor(label: string, original: string): string {
    let hash = this.hashCache.get(original);
    if (!hash) {
      hash = createHmac("sha256", this.salt).update(original).digest("hex").slice(0, 8);
      if (this.hashCache.size > 50_000) this.hashCache.clear();
      this.hashCache.set(original, hash);
    }
    return this.template.replace("{label}", label).replace("{hash}", hash);
  }

  /** Finds validated, de-overlapped matches. Existing placeholders are never matched again. */
  findMatches(text: string): TextMatch[] {
    if (this.isEmpty || text.length === 0) return [];

    const protectedSpans: Array<[number, number]> = [];
    this.placeholderRegex.lastIndex = 0;
    for (const match of text.matchAll(this.placeholderRegex)) {
      const start = match.index ?? 0;
      protectedSpans.push([start, start + match[0].length]);
    }

    const raw: TextMatch[] = [];
    let lower: string | null = null;

    for (const rule of this.regexRules) {
      if (rule.keywords) {
        lower ??= text.toLowerCase();
        const haystack = lower;
        if (!rule.keywords.some((keyword) => haystack.includes(keyword))) continue;
      }
      rule.regex.lastIndex = 0;
      let count = 0;
      let match: RegExpExecArray | null = rule.regex.exec(text);
      while (match !== null) {
        if (match[0].length === 0) {
          rule.regex.lastIndex++;
        } else {
          const group = rule.def.group ?? 0;
          const span = match.indices?.[group];
          if (span && span[1] > span[0]) {
            const part = text.slice(span[0], span[1]);
            if (
              !this.isAllowed(part) &&
              passesValidators(part, rule.def.validators, rule.def.minEntropy)
            ) {
              raw.push({ start: span[0], end: span[1], ruleIndex: rule.index });
            }
          }
          if (++count >= MAX_MATCHES_PER_RULE) break;
        }
        match = rule.regex.exec(text);
      }
    }

    if (this.literalRegex) {
      this.literalRegex.lastIndex = 0;
      for (const match of text.matchAll(this.literalRegex)) {
        const start = match.index ?? 0;
        const ruleIndex = this.literalRuleIndex.get(match[0]);
        if (ruleIndex !== undefined && !this.isAllowed(match[0])) {
          raw.push({ start, end: start + match[0].length, ruleIndex });
        }
      }
    }

    if (raw.length === 0) return [];

    const filtered =
      protectedSpans.length === 0
        ? raw
        : raw.filter((m) => !protectedSpans.some(([start, end]) => m.start < end && m.end > start));

    filtered.sort((a, b) => a.start - b.start || a.ruleIndex - b.ruleIndex);
    const merged: TextMatch[] = [];
    for (const match of filtered) {
      const last = merged[merged.length - 1];
      if (last && match.start < last.end) {
        last.end = Math.max(last.end, match.end);
        last.ruleIndex = Math.min(last.ruleIndex, match.ruleIndex);
      } else {
        merged.push({ ...match });
      }
    }
    return merged;
  }

  /** Rewrites one string; replacements are literal and never matched again. */
  redactText(text: string, matches = this.findMatches(text)) {
    if (matches.length === 0) {
      return { text, redactions: [] as TextRedaction[] };
    }
    const redactions: TextRedaction[] = [];
    let out = "";
    let pos = 0;
    for (const match of matches) {
      const def = this.rules[match.ruleIndex];
      const original = text.slice(match.start, match.end);
      const replacement = this.placeholderFor(def.label, original);
      out += text.slice(pos, match.start) + replacement;
      pos = match.end;
      redactions.push({
        start: match.start,
        end: match.end,
        ruleId: def.id,
        ruleName: def.name,
        category: def.category,
        original,
        replacement,
      });
    }
    out += text.slice(pos);
    return { text: out, redactions };
  }
}
