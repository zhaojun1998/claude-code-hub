import { describe, expect, test } from "vitest";
import {
  compileRuleRegex,
  DEFAULT_PLACEHOLDER_TEMPLATE,
  isBroadPattern,
  passesValidators,
  RedactionEngine,
} from "@/lib/redaction/engine";
import type { RedactionRuleDefinition } from "@/lib/redaction/types";

function rule(
  partial: Partial<RedactionRuleDefinition> & Pick<RedactionRuleDefinition, "id" | "pattern">
) {
  return {
    name: partial.id,
    category: "secret",
    label: "SECRET",
    kind: "regex",
    source: "custom",
    ...partial,
  } as RedactionRuleDefinition;
}

describe("RedactionEngine", () => {
  test("placeholders are deterministic per value and salt", () => {
    const rules = [rule({ id: "custom:1", pattern: "acme_[a-z0-9]{8}" })];
    const a = new RedactionEngine(rules, { salt: "s1" });
    const b = new RedactionEngine(rules, { salt: "s1" });
    const c = new RedactionEngine(rules, { salt: "s2" });
    const text = "token acme_abcd1234 and acme_abcd1234 and acme_zzzz9999";
    const first = a.redactText(text);
    expect(first.text).toBe(b.redactText(text).text);
    expect(first.text).not.toBe(c.redactText(text).text);
    expect(first.redactions).toHaveLength(3);
    expect(first.redactions[0].replacement).toBe(first.redactions[1].replacement);
    expect(first.redactions[0].replacement).not.toBe(first.redactions[2].replacement);
    expect(a.version).toBe(b.version);
    expect(a.version).not.toBe(c.version);
  });

  test("custom template and fallback when {hash} is missing", () => {
    const rules = [rule({ id: "custom:1", label: "TOKEN", pattern: "acme_[a-z0-9]{8}" })];
    const custom = new RedactionEngine(rules, {
      salt: "s",
      placeholderTemplate: "<<{label}:{hash}>>",
    });
    expect(custom.redactText("acme_abcd1234").text).toMatch(/^<<TOKEN:[0-9a-f]{8}>>$/);
    const fallback = new RedactionEngine(rules, { salt: "s", placeholderTemplate: "<<{label}>>" });
    expect(fallback.redactText("acme_abcd1234").text).toMatch(/^\[REDACTED:TOKEN#[0-9a-f]{8}\]$/);
    expect(DEFAULT_PLACEHOLDER_TEMPLATE).toContain("{hash}");
  });

  test("overlapping matches merge and the earlier rule names the placeholder", () => {
    const engine = new RedactionEngine(
      [
        rule({ id: "custom:1", label: "FIRST", pattern: "abc123" }),
        rule({ id: "custom:2", label: "SECOND", pattern: "123def" }),
      ],
      { salt: "s" }
    );
    const result = engine.redactText("xx abc123def yy");
    expect(result.redactions).toHaveLength(1);
    expect(result.redactions[0].original).toBe("abc123def");
    expect(result.redactions[0].ruleId).toBe("custom:1");
    expect(result.text).toMatch(/^xx \[REDACTED:FIRST#[0-9a-f]{8}\] yy$/);
  });

  test("capture group replacement", () => {
    const engine = new RedactionEngine(
      [rule({ id: "custom:1", pattern: "secret=(\\w+)", group: 1 })],
      { salt: "s" }
    );
    expect(engine.redactText("secret=hunter22").text).toMatch(/^secret=\[REDACTED:SECRET#/);
  });

  test("literal rules, short literals and invalid regexes", () => {
    const engine = new RedactionEngine(
      [
        rule({ id: "jev:1", kind: "literal", pattern: "Pr0j3ct-Phoenix", label: "INTERNAL" }),
        rule({ id: "jev:2", kind: "literal", pattern: "abc" }),
        rule({ id: "custom:3", pattern: "([" }),
      ],
      { salt: "s" }
    );
    expect(engine.issues.map((issue) => issue.ruleId).sort()).toEqual(["custom:3", "jev:2"]);
    const result = engine.redactText("Release Pr0j3ct-Phoenix (a.k.a. Pr0j3ct-Phoenix) today");
    expect(result.redactions).toHaveLength(2);
    expect(result.redactions[0].ruleId).toBe("jev:1");
    expect(result.text).not.toContain("Phoenix");
  });

  test("allowlist skips exact values case-insensitively", () => {
    const engine = new RedactionEngine([rule({ id: "custom:1", pattern: "acme_[a-z0-9]{8}" })], {
      salt: "s",
      allowlist: ["ACME_PUBLIC1", " "],
    });
    expect(engine.findMatches("acme_public1 acme_secret99")).toHaveLength(1);
  });

  test("existing placeholders are never matched again (idempotent)", () => {
    const engine = new RedactionEngine(
      [rule({ id: "custom:1", pattern: "password:\\s*(\\S+)", group: 1, label: "PASSWORD" })],
      { salt: "s" }
    );
    const once = engine.redactText("password: Hunter2Hunter2").text;
    const twice = engine.redactText(once).text;
    expect(twice).toBe(once);
  });

  test("keywords pre-filter and validators", () => {
    const engine = new RedactionEngine(
      [rule({ id: "custom:1", pattern: "\\d{16}", keywords: ["card"], validators: ["luhn"] })],
      { salt: "s" }
    );
    expect(engine.findMatches("4111111111111111")).toHaveLength(0);
    expect(engine.findMatches("card 4111111111111111")).toHaveLength(1);
    expect(engine.findMatches("card 4111111111111112")).toHaveLength(0);
    expect(passesValidators("abc", undefined, undefined)).toBe(true);
    expect(passesValidators("aaaaaaaaaaaa", ["entropy"], 1)).toBe(false);
  });

  test("empty engine and empty text", () => {
    const engine = new RedactionEngine([], { salt: "s" });
    expect(engine.isEmpty).toBe(true);
    expect(engine.findMatches("anything")).toEqual([]);
    expect(engine.redactText("anything")).toEqual({ text: "anything", redactions: [] });
    const nonEmpty = new RedactionEngine([rule({ id: "custom:1", pattern: "x+" })], { salt: "s" });
    expect(nonEmpty.findMatches("")).toEqual([]);
  });

  test("zero-length matches do not loop forever", () => {
    const engine = new RedactionEngine([rule({ id: "custom:1", pattern: "a*" })], { salt: "s" });
    expect(engine.findMatches("bbb aa bbb")).toHaveLength(1);
  });

  test("compileRuleRegex and isBroadPattern", () => {
    expect(typeof compileRuleRegex({ pattern: "(" })).toBe("string");
    const ok = compileRuleRegex({ pattern: "abc", flags: "ixg" });
    expect(ok).toBeInstanceOf(RegExp);
    expect((ok as RegExp).flags).toContain("i");
    expect(isBroadPattern(compileRuleRegex({ pattern: ".*" }) as RegExp)).toBe(true);
    expect(isBroadPattern(compileRuleRegex({ pattern: "[\\s\\S]+" }) as RegExp)).toBe(true);
    expect(isBroadPattern(compileRuleRegex({ pattern: "sk-[a-z]{20}" }) as RegExp)).toBe(false);
  });
});
