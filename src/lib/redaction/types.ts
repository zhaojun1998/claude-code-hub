/**
 * Outbound request redaction (fork feature).
 *
 * Shared types for the rule engine, the request body walker, the incremental
 * finding tracker and Jev-based rule discovery.
 */

export type RedactionCategory = "secret" | "pii" | "network" | "custom";

export type RedactionRuleKind = "regex" | "literal";

export type RedactionRuleSource = "builtin" | "custom" | "jev";

/** Extra checks applied to a regex match before it is accepted. */
export type RedactionValidator =
  | "luhn"
  | "cn_id"
  | "cn_phone"
  | "cn_uscc"
  | "iban"
  | "entropy"
  | "not_placeholder"
  | "looks_real"
  | "mixed_alnum"
  | "credential"
  | "jwt"
  | "email"
  | "ipv4_public";

export interface RedactionRuleDefinition {
  /** Stable identifier: `builtin:<slug>`, `custom:<id>` or `jev:<id>`. */
  id: string;
  name: string;
  category: RedactionCategory;
  /** Upper-case label used inside the placeholder, e.g. `OPENAI_KEY`. */
  label: string;
  kind: RedactionRuleKind;
  /** Regex source (kind=regex) or the exact value to hide (kind=literal). */
  pattern: string;
  /** Regex flags without `g` (always added). Ignored for literals. */
  flags?: string;
  /** Capture group that holds the sensitive part; 0 or undefined means the whole match. */
  group?: number;
  validators?: RedactionValidator[];
  /** Minimum Shannon entropy (bits per char) for the `entropy` validator. */
  minEntropy?: number;
  /** Case-insensitive pre-filter: the rule only runs when one keyword occurs in the text. */
  keywords?: string[];
  source: RedactionRuleSource;
  description?: string;
  /** Example that the rule must match; used by tests and the settings page. */
  example?: string;
  /** Built-in rules only: whether the rule is on when the admin has not overridden it. */
  defaultEnabled?: boolean;
}

export interface TextMatch {
  start: number;
  end: number;
  ruleIndex: number;
}

export interface TextRedaction {
  start: number;
  end: number;
  ruleId: string;
  ruleName: string;
  category: RedactionCategory;
  original: string;
  replacement: string;
}

/** A redaction found in one string of the outbound request body. */
export interface BodyRedaction extends TextRedaction {
  /** JSON path of the string inside the request body, e.g. `messages[3].content[0].text`. */
  path: string;
  /** Fingerprint of the whole original string (used for incremental tracking). */
  segmentFingerprint: string;
  /** Short original text around the value. */
  contextBefore: string;
  contextAfter: string;
}

/** A finding persisted for the usage log. */
export interface RedactionFinding {
  ruleId: string;
  ruleName: string;
  category: RedactionCategory;
  original: string;
  replacement: string;
  path: string;
  contextBefore: string;
  contextAfter: string;
}

export interface RedactionEventRecord {
  id: number;
  messageRequestId: number | null;
  sessionId: string | null;
  requestSequence: number | null;
  totalCount: number;
  newCount: number;
  originalsRecorded: boolean;
  findings: RedactionFinding[];
  createdAt: string;
}

export interface RedactionEventSummary {
  messageRequestId: number;
  totalCount: number;
  newCount: number;
}

export type JevProvider = "typesafe" | "openrouter";

export type JevMode = "sync" | "async";

export type JevSendMode = "masked" | "full";

export interface JevSettings {
  enabled: boolean;
  provider: JevProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: JevMode;
  timeoutMs: number;
  /** Candidates at or above this confidence become active rules immediately. */
  autoEnableThreshold: number;
  /** Candidates at or above this confidence are kept as pending suggestions. */
  suggestThreshold: number;
  sendMode: JevSendMode;
  maxCandidatesPerRequest: number;
}

export interface RedactionSettings {
  enabled: boolean;
  /** Placeholder template; `{label}` and `{hash}` are substituted. */
  placeholderTemplate: string;
  /** Admin overrides of the built-in rules' default on/off state, keyed by rule id. */
  builtinOverrides: Record<string, boolean>;
  /** Exact values (case-insensitive) that are never redacted. */
  allowlist: string[];
  /** Store original values in the usage log redaction records. */
  recordOriginals: boolean;
  /** How long a session remembers already reported findings. */
  incrementalTtlHours: number;
  /** Redaction records older than this are removed. */
  eventRetentionDays: number;
  jev: JevSettings;
}

export type DiscoveredRuleStatus = "active" | "pending" | "rejected";

export interface StoredRedactionRule {
  id: number;
  name: string;
  category: RedactionCategory;
  label: string;
  kind: RedactionRuleKind;
  pattern: string;
  flags: string | null;
  groupIndex: number | null;
  source: Exclude<RedactionRuleSource, "builtin">;
  status: DiscoveredRuleStatus;
  confidence: number | null;
  description: string | null;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
}
