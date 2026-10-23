/**
 * Shapes exchanged between the redaction settings UI, the fork REST route and the server
 * actions. Kept free of runtime imports so client components can depend on it.
 */

import type { PublicRedactionSettings } from "./config";
import type {
  DiscoveredRuleStatus,
  RedactionCategory,
  RedactionRuleKind,
  StoredRedactionRule,
} from "./types";

export interface BuiltinRuleView {
  id: string;
  name: string;
  category: RedactionCategory;
  label: string;
  description: string | null;
  example: string | null;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface RedactionOverview {
  settings: PublicRedactionSettings;
  builtinRules: BuiltinRuleView[];
  rules: StoredRedactionRule[];
  verdicts: { sensitive: number; benign: number };
}

export interface RedactionPreview {
  redactedText: string;
  redactions: Array<{
    ruleId: string;
    ruleName: string;
    category: RedactionCategory;
    original: string;
    replacement: string;
    start: number;
    end: number;
  }>;
  candidates: Array<{ preview: string; hint: string; keyName: string | null }>;
}

export interface JevTestResult {
  ok: boolean;
  error?: string;
  durationMs: number;
  model?: string;
  category?: string;
  confidence?: number;
}

export interface RuleFormInput {
  name: string;
  category: RedactionCategory;
  label: string;
  kind: RedactionRuleKind;
  pattern: string;
  flags?: string | null;
  groupIndex?: number | null;
  description?: string | null;
  status?: DiscoveredRuleStatus;
}
