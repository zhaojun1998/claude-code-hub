/**
 * Local candidate extraction for Jev rule discovery.
 *
 * Only cheap, local heuristics run here; nothing leaves the process. A candidate is a value
 * that is not covered by any rule yet but looks like it could be a credential or private
 * identifier: the right-hand side of a secret-looking assignment, a long high-entropy token,
 * or a password embedded in a connection URL. Jev then decides which candidates are real.
 */

import { createHash } from "node:crypto";
import { maskValue } from "./mask";
import type { TextMatch } from "./types";
import { charsetClassCount, looksLikePlaceholder, shannonEntropy } from "./validators";

export type CandidateHint = "assignment" | "high_entropy" | "url_credential";

export interface DiscoveryCandidate {
  value: string;
  valueHash: string;
  hint: CandidateHint;
  keyName?: string;
  path: string;
  start: number;
  end: number;
  contextBefore: string;
  contextAfter: string;
}

const CONTEXT_CHARS = 80;
const MAX_CANDIDATES_PER_TEXT = 20;

const ASSIGNMENT_REGEX =
  /(?<![A-Za-z0-9_])((?:[A-Za-z_][A-Za-z0-9_.-]{0,40}?)?(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|credential|auth|cookie|private[_-]?key|access[_-]?key|signing[_-]?key|client[_-]?secret|dsn|salt)[A-Za-z0-9_]{0,20})["']?\s*(?::=|=>|[:=])\s*["'`]?([^\s"'`,;(){}<>[\]]{6,256})/gi;

// `=` only as trailing base64 padding, so `KEY=value` is not taken as one token.
const TOKEN_REGEX = /(?<![A-Za-z0-9+/_.~=-])[A-Za-z0-9+/_.~-]{24,256}={0,2}(?![A-Za-z0-9+/_.~=-])/g;

const URL_CREDENTIAL_REGEX =
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{1,128}:([^\s@/'"]{3,256})@[^\s/'"]+/gi;

const NON_SECRET_VALUES = new Set([
  "true",
  "false",
  "null",
  "none",
  "undefined",
  "string",
  "number",
  "boolean",
  "required",
  "optional",
  "default",
  "object",
  "function",
  "bearer",
  "basic",
  "secret",
  "password",
  "token",
]);

export function hashCandidateValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function overlaps(start: number, end: number, spans: TextMatch[]): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

/** Slice of `text` in which already-covered rule matches are replaced by a marker. */
function maskedSlice(text: string, from: number, to: number, covered: TextMatch[]): string {
  const start = Math.max(0, from);
  const end = Math.min(text.length, to);
  let out = "";
  let pos = start;
  for (const span of covered) {
    if (span.end <= start || span.start >= end) continue;
    out += text.slice(pos, Math.max(pos, span.start));
    out += "[MASKED]";
    pos = Math.min(end, span.end);
  }
  return out + text.slice(pos, end);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Values that look random but are routinely public: hashes, ids, paths, versions. */
function isBenignToken(value: string): boolean {
  if (isUuid(value)) return true;
  if (/^[0-9a-f]+$/i.test(value) && [32, 40, 56, 64, 96, 128].includes(value.length)) return true;
  if (/^\d+$/.test(value)) return true;
  if ((value.match(/\//g)?.length ?? 0) >= 2) return true;
  if (/^(?:https?|ftp|file|data):/i.test(value)) return true;
  if (
    /^[\w.-]+\.(?:js|ts|tsx|jsx|json|md|py|go|rs|java|css|html|yml|yaml|toml|lock|png|jpg|svg)$/i.test(
      value
    )
  ) {
    return true;
  }
  if (/^v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?$/.test(value)) return true;
  // camelCase / snake_case identifiers without digits are code, not secrets.
  if (!/\d/.test(value) && /^[A-Za-z_]+$/.test(value)) return true;
  // Dotted identifiers such as package or property paths.
  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value)) return true;
  return false;
}

export function isPlausibleSecretValue(value: string, hint: CandidateHint): boolean {
  if (value.length < 6 || value.length > 256) return false;
  if (looksLikePlaceholder(value)) return false;
  if (NON_SECRET_VALUES.has(value.toLowerCase())) return false;
  if (/^\$|^process\.env|^os\.environ|^env\(|^getenv/i.test(value)) return false;
  if (hint === "high_entropy") {
    if (isBenignToken(value)) return false;
    if (charsetClassCount(value) < 2) return false;
    return shannonEntropy(value) >= (value.length >= 40 ? 4.2 : 3.8);
  }
  if (hint === "assignment") {
    if (/^[a-z]+$/i.test(value) && value.length < 12) return false;
    if (isUuid(value)) return false;
    // Property paths such as request.headers.authorization are code references.
    if (!/\d/.test(value) && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)) return false;
    return shannonEntropy(value) >= 2.5;
  }
  return true;
}

/**
 * Extracts discovery candidates from one string. `covered` are rule matches already found in
 * the same string; overlapping candidates are skipped because they are redacted anyway.
 */
export function extractCandidates(
  text: string,
  path: string,
  covered: TextMatch[] = []
): DiscoveryCandidate[] {
  if (text.length < 6) return [];
  const results: DiscoveryCandidate[] = [];
  const seen = new Set<string>();

  const push = (value: string, start: number, hint: CandidateHint, keyName?: string) => {
    const end = start + value.length;
    if (results.length >= MAX_CANDIDATES_PER_TEXT) return;
    if (seen.has(value) || overlaps(start, end, covered)) return;
    if (results.some((candidate) => start < candidate.end && end > candidate.start)) return;
    if (!isPlausibleSecretValue(value, hint)) return;
    seen.add(value);
    results.push({
      value,
      valueHash: hashCandidateValue(value),
      hint,
      keyName,
      path,
      start,
      end,
      contextBefore: maskedSlice(text, start - CONTEXT_CHARS, start, covered),
      contextAfter: maskedSlice(text, end, end + CONTEXT_CHARS, covered),
    });
  };

  for (const match of text.matchAll(URL_CREDENTIAL_REGEX)) {
    const password = match[1];
    const start = (match.index ?? 0) + match[0].indexOf(`:${password}@`) + 1;
    push(password, start, "url_credential");
  }

  for (const match of text.matchAll(ASSIGNMENT_REGEX)) {
    const value = match[2];
    const start = (match.index ?? 0) + match[0].lastIndexOf(value);
    push(value, start, "assignment", match[1]);
  }

  for (const match of text.matchAll(TOKEN_REGEX)) {
    push(match[0], match.index ?? 0, "high_entropy");
  }

  return results;
}

/** Short shape description that reveals no more than the first and last characters. */
export function describeCandidateShape(value: string): string {
  const classes: string[] = [];
  if (/[a-z]/.test(value)) classes.push("lower");
  if (/[A-Z]/.test(value)) classes.push("upper");
  if (/\d/.test(value)) classes.push("digit");
  const symbols = [...new Set(value.replace(/[A-Za-z0-9]/g, ""))].join("");
  const head = value.length > 12 ? value.slice(0, 4) : value.slice(0, 1);
  const tail = value.length > 12 ? value.slice(-2) : "";
  return [
    `starts with "${head}"`,
    tail ? `ends with "${tail}"` : null,
    `${value.length} chars`,
    `character classes: ${classes.join("+") || "none"}${symbols ? `, symbols "${symbols}"` : ""}`,
    `entropy ${shannonEntropy(value).toFixed(2)} bits/char`,
  ]
    .filter(Boolean)
    .join("; ");
}

export { maskValue };

const TOKEN_PREFIX_REGEX = /^([A-Za-z][A-Za-z0-9]{1,11}[_-])([A-Za-z0-9_-]{16,})$/;

/**
 * Generalizes a vendor-prefixed token (`abc_<random>`) into a regex that matches the same
 * token family. Returns null when the value has no recognizable prefix.
 */
export function deriveTokenPattern(value: string): string | null {
  const match = TOKEN_PREFIX_REGEX.exec(value);
  if (!match) return null;
  const [, prefix, body] = match;
  if (shannonEntropy(body) < 3.5 || charsetClassCount(body) < 2) return null;
  const min = Math.max(16, body.length - 8);
  const max = body.length + 8;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return `(?<![A-Za-z0-9_-])${escaped}[A-Za-z0-9_-]{${min},${max}}(?![A-Za-z0-9_-])`;
}
